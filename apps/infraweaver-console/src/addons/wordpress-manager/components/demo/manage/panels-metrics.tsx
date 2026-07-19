"use client";

// Metrics panel — the Connector fleet exporter, per site. Two honest halves:
//  • Live: an on-demand signed metrics.snapshot (NOT stored) with an explicit
//    "last checked at" — the exact moment of the signed read.
//  • History: read back from Prometheus (the durable store the ServiceMonitor
//    scrapes into). Degrades to a note when Prometheus is unconfigured/unreachable.
import { Activity, Clock, Database, Gauge, KeyRound, LineChart, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectorMetricsPanelData, MetricsHistorySeries } from "../../../lib/manage/types";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[13px]")}>
        {value}
      </p>
    </div>
  );
}

/** A history series rendered as a stat tile: latest value + a sparkline of the window. */
function HistoryTile({ series }: { series: MetricsHistorySeries }) {
  const values = series.points.map((p) => p.v);
  const latest = values.length > 0 ? values[values.length - 1] : 0;
  return (
    <StatTile
      label={series.label}
      value={latest}
      suffix={series.unit ? ` ${series.unit}` : ""}
      tone={healthTone(series.id === "up" ? (latest >= 1 ? 96 : 30) : 78)}
      spark={values.length > 1 ? values : undefined}
    />
  );
}

export function MetricsPanel({ site }: { site: string }) {
  const state = useManagePanel<ConnectorMetricsPanelData>(site, "metrics");

  return (
    <PanelState state={state}>
      {(data) => {
        const { live, history } = data;
        const r = live.result;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              className="lg:col-span-2"
              title="Live telemetry"
              description="Read on-demand over the signed metrics.snapshot channel — not stored."
              icon={Activity}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn(PILL, live.ok ? TONE.good : TONE.critical)}>
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  {live.ok ? "Signed read verified" : live.error ?? "Signed read failed"}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Last checked at <span className="font-medium text-zinc-700 dark:text-zinc-300">{fmtTime(live.checkedAt)}</span>
                </span>
              </div>

              {r ? (
                <>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatTile label="Round-trip" value={live.roundtripMs ?? 0} suffix=" ms" icon={Gauge} tone={healthTone(85)} />
                    <StatTile label="Command seq" value={r.last_seq} icon={Activity} tone={healthTone(80)} />
                    <StatTile label="Nonce cache" value={r.nonce_cache} icon={Database} tone={healthTone(78)} />
                    <StatTile label="WP key epoch" value={r.wp_kid} icon={KeyRound} tone={healthTone(82)} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Fact label="Connector" value={r.plugin} mono />
                    <Fact label="PHP" value={r.php} mono />
                    <Fact label="WordPress" value={r.wp ?? "—"} mono />
                    <Fact label="IW key epoch" value={`${r.iw_kid}`} />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className={cn(PILL, r.rotation_pending ? TONE.warn : TONE.neutral)}>
                      {r.rotation_pending ? "Key rotation pending" : "No rotation pending"}
                    </span>
                    <span className={cn(PILL, r.sodium ? TONE.good : TONE.critical)}>
                      {r.sodium ? "libsodium available" : "libsodium missing"}
                    </span>
                    {r.last_reroll_at > 0 ? (
                      <span className={cn(PILL, r.last_reroll_ok ? TONE.good : TONE.warn)}>
                        <KeyRound className="h-3.5 w-3.5" aria-hidden />
                        Last reroll {new Date(r.last_reroll_at * 1000).toLocaleDateString()} · {r.last_reroll_ok ? "confirmed" : "aborted"}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-200">
                  No signed telemetry returned{live.error ? ` — ${live.error}` : ""}. The link may be quarantined or mid-restart.
                </div>
              )}
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              title={`History · last ${history.windowHours}h`}
              description="Read back from Prometheus — the durable store the ServiceMonitor scrapes into."
              icon={LineChart}
            >
              {history.available && history.series.some((s) => s.points.length > 0) ? (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {history.series.map((series) => (
                    <HistoryTile key={series.id} series={series} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  <RefreshCw className="h-5 w-5" aria-hidden />
                  {history.available
                    ? "No history yet — Prometheus has not collected samples for this site over the window."
                    : history.reason ?? "History is unavailable."}
                </div>
              )}
              {history.available && history.series[0]?.points.length ? (
                <p className="mt-3 text-[11px] text-zinc-400 dark:text-zinc-500">
                  Sparklines span the full window; the number is the latest scraped sample.
                </p>
              ) : null}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
