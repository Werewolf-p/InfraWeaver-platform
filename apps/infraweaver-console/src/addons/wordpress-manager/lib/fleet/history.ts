import "server-only";
import { isPrometheusConfigured, promQueryRange } from "@/lib/prometheus";

/**
 * Fleet-wide Prometheus history — the read-only trend companion to the live
 * `aggregate.ts` roll-up. It queries ONLY the series the token-gated IWSL
 * exporter already scraped (the console never writes to Prometheus), and reads
 * fleet-wide aggregates (sum/avg across every connector), never per-site data.
 *
 * Mirrors the "degrade when Prometheus is unconfigured/unreachable" contract of
 * lib/manage/probes/metrics.ts: when PROMETHEUS_URL is unset, or any query
 * errors, this returns `available:false` with a human reason and NO fabricated
 * points — the live current values (from useFleet) stand on their own.
 *
 * There is no PromQL-injection surface here: every query below is a static
 * literal with no interpolated value (unlike the per-site probe, which guards a
 * `site=""` label matcher).
 */

/** One point in a fleet trend series: unix seconds + value. */
export interface FleetHistoryPoint {
  readonly t: number;
  readonly v: number;
}

/** One plotted fleet-wide metric over the window. */
export interface FleetHistorySeries {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly points: readonly FleetHistoryPoint[];
}

/**
 * Fleet trend payload. `available:false` (+ `reason`) is the honest "no trends"
 * state — Prometheus off or a query failed — never seeded numbers.
 */
export interface FleetHistory {
  readonly available: boolean;
  readonly windowHours: number;
  readonly reason?: string;
  readonly series: readonly FleetHistorySeries[];
}

/** 24h window at 5-min steps ≈ 288 points — a full day of fleet trend. */
const HISTORY_WINDOW_HOURS = 24;
const HISTORY_STEP_SECONDS = 300;
const PROM_TIMEOUT_MS = 5_000;

/** The fleet-wide aggregates we plot over time — all static PromQL, no interpolation. */
const HISTORY_SPECS: readonly { id: string; label: string; unit?: string; query: string }[] = [
  { id: "connectors_up", label: "Connectors up", query: "sum(iwsl_connector_up)" },
  { id: "avg_roundtrip_ms", label: "Avg round-trip", unit: "ms", query: "avg(iwsl_connector_roundtrip_milliseconds)" },
  { id: "commands_seq", label: "Commands (seq total)", query: "sum(iwsl_connector_last_seq)" },
];

/**
 * Fleet-wide trend series over the last 24h. Degrades to `available:false` with a
 * reason when Prometheus is unconfigured or any range query fails.
 */
export async function getFleetHistory(): Promise<FleetHistory> {
  if (!isPrometheusConfigured()) {
    return {
      available: false,
      windowHours: HISTORY_WINDOW_HOURS,
      reason: "Trends need Prometheus (set PROMETHEUS_URL) — showing current values only.",
      series: [],
    };
  }
  const end = Math.floor(Date.now() / 1000);
  const start = end - HISTORY_WINDOW_HOURS * 3600;
  try {
    const series: FleetHistorySeries[] = await Promise.all(
      HISTORY_SPECS.map(async (spec) => {
        const result = await promQueryRange(spec.query, {
          start,
          end,
          step: HISTORY_STEP_SECONDS,
          timeoutMs: PROM_TIMEOUT_MS,
        });
        const points = (result[0]?.values ?? [])
          .map(([t, v]) => ({ t: Number(t), v: Number(v) }))
          .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
        return { id: spec.id, label: spec.label, unit: spec.unit, points };
      }),
    );
    return { available: true, windowHours: HISTORY_WINDOW_HOURS, series };
  } catch (err) {
    // Prometheus down / query error → no trends, but the live fleet read is
    // unaffected: the Monitoring tab still shows current values.
    return {
      available: false,
      windowHours: HISTORY_WINDOW_HOURS,
      reason: err instanceof Error ? err.message : "Prometheus query failed",
      series: [],
    };
  }
}
