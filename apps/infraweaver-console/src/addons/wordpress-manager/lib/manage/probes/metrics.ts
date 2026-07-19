import "server-only";
import { isPrometheusConfigured, promQueryRange } from "@/lib/prometheus";
import { connectorMetrics } from "../../iwsl-managed-ops";
import type { ConnectorMetricsResult } from "../../rpc/registry";
import type {
  ConnectorMetricsPanelData,
  MetricsHistorySeries,
} from "../types";
import type { PanelProbe, PanelProbeContext } from "./contract";

/**
 * Metrics panel probe. Two independent reads, neither of which weakens the
 * security model:
 *
 *   - LIVE: one on-demand signed `metrics.snapshot` over the IWSL command channel
 *     (the same dual-signed, pinned-key-verified path as health.check). The
 *     result is NOT persisted — it is stamped with `checkedAt` and cached only by
 *     the per-replica manage snapshot cache (25s SWR), so the panel shows "last
 *     checked at …" without ever writing telemetry to durable state.
 *   - HISTORY: a read-only PromQL range query against the Prometheus that scrapes
 *     the token-gated exporter. The console never writes to Prometheus; it only
 *     reads back the series it already exported. Degrades to `available:false`
 *     with a reason when Prometheus is unconfigured/unreachable — the live read
 *     stands on its own.
 *
 * Requires the `connector` capability, so it only runs on a site with an active,
 * fingerprint-confirmed signed link.
 */

/** History window + resolution. 6h at 5-min steps ≈ 72 points — enough for a sparkline. */
const HISTORY_WINDOW_HOURS = 6;
const HISTORY_STEP_SECONDS = 300;
const PROM_TIMEOUT_MS = 5_000;

/** Narrow the plugin's untyped result into the numeric snapshot shape. */
function asMetricsResult(result: Record<string, unknown>): ConnectorMetricsResult | null {
  return typeof result.last_seq === "number" ? (result as unknown as ConnectorMetricsResult) : null;
}

async function readLive(site: string): Promise<ConnectorMetricsPanelData["live"]> {
  const checkedAt = new Date().toISOString();
  try {
    const reply = await connectorMetrics(site);
    return {
      ok: reply.ok && !reply.rejectedReason,
      checkedAt,
      roundtripMs: reply.roundtripMs,
      result: asMetricsResult(reply.result),
      ...(reply.rejectedReason ? { error: reply.rejectedReason } : {}),
    };
  } catch (err) {
    // A signature-tamper quarantine (or any transport fault) surfaces as a
    // read-side error — never a throw that blanks the whole panel.
    return { ok: false, checkedAt, roundtripMs: null, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The gauges we plot over time — a curated subset of the exported series. */
const HISTORY_SPECS: readonly { id: string; label: string; unit?: string; metric: string }[] = [
  { id: "up", label: "Connector up", metric: "iwsl_connector_up" },
  { id: "roundtrip_ms", label: "Round-trip", unit: "ms", metric: "iwsl_connector_roundtrip_milliseconds" },
  { id: "last_seq", label: "Command seq", metric: "iwsl_connector_last_seq" },
  { id: "nonce_cache", label: "Nonce cache", metric: "iwsl_connector_nonce_cache_entries" },
];

async function readHistory(site: string): Promise<ConnectorMetricsPanelData["history"]> {
  if (!isPrometheusConfigured()) {
    return {
      available: false,
      windowHours: HISTORY_WINDOW_HOURS,
      reason: "Prometheus is not configured (set PROMETHEUS_URL) — live telemetry only.",
      series: [],
    };
  }
  // `site` is already validated by the panel dispatcher (assertValidSiteId). This
  // regex is defence-in-depth: only a safe slug reaches a PromQL label matcher, so
  // no value can break out of the quoted selector (no PromQL injection).
  if (!/^[a-z0-9-]+$/.test(site)) {
    return { available: false, windowHours: HISTORY_WINDOW_HOURS, reason: "Unsupported site id for history query.", series: [] };
  }
  const end = Math.floor(Date.now() / 1000);
  const start = end - HISTORY_WINDOW_HOURS * 3600;
  try {
    const series: MetricsHistorySeries[] = await Promise.all(
      HISTORY_SPECS.map(async (spec) => {
        const result = await promQueryRange(`${spec.metric}{site="${site}"}`, {
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
    // Prometheus down / query error: history unavailable, but the live signed
    // read above is unaffected — the panel still renders current telemetry.
    return {
      available: false,
      windowHours: HISTORY_WINDOW_HOURS,
      reason: err instanceof Error ? err.message : "Prometheus query failed",
      series: [],
    };
  }
}

async function fetchMetrics(ctx: PanelProbeContext): Promise<ConnectorMetricsPanelData> {
  // Live and history are independent; run them together so a slow Prometheus
  // never delays the signed read and vice-versa.
  const [live, history] = await Promise.all([readLive(ctx.site), readHistory(ctx.site)]);
  return { live, history };
}

export const metricsProbe: PanelProbe<ConnectorMetricsPanelData> = {
  id: "metrics",
  requiresCapability: "connector",
  fetch: fetchMetrics,
};
