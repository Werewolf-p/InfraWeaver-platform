"use client";

import { motion } from "framer-motion";
import {
  Activity,
  ArrowUpCircle,
  CheckCircle2,
  Link2,
  RefreshCw,
  ServerCrash,
  Timer,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetSiteRow, FleetSiteStatus } from "../../lib/fleet/types";
import type { FleetHistory, FleetHistorySeries } from "../../lib/fleet/history";
import { riseItem, staggerContainer } from "./motion";
import { useFleet } from "./use-fleet";
import { useFleetHistory } from "./use-fleet-history";
import { ResponseTimeLine } from "./charts";
import {
  AnimatedNumber,
  SectionCard,
  Sparkline,
  StatTile,
  STATUS_LABEL,
  STATUS_TONE,
  healthTone,
} from "./widgets";

// Solid status colours for the per-site status dots (Tailwind classes, keyed by
// the same union widgets' STATUS_TONE uses) — mirrors fleet-overview.tsx.
const STATUS_SOLID: Readonly<Record<FleetSiteStatus, string>> = {
  healthy: "bg-emerald-500",
  attention: "bg-amber-500",
  critical: "bg-red-500",
  offline: "bg-zinc-400",
};

const SKELETON_TILES: readonly number[] = [0, 1, 2, 3];

/** Shown when Prometheus is off/unreachable — never a fabricated chart. */
const HISTORY_FALLBACK_REASON = "Trends need Prometheus (PROMETHEUS_URL) — showing current values only.";

/** Resolve the honest reason there is no trend chart to draw. */
function resolveHistoryReason(history: FleetHistory | null, historyError: string | null): string {
  if (historyError) return historyError;
  if (history && !history.available && history.reason) return history.reason;
  return HISTORY_FALLBACK_REASON;
}

function MonitoringSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SKELETON_TILES.map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40"
          />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
        <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      </div>
      <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
    </div>
  );
}

function MonitoringErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <ServerCrash className="mx-auto h-6 w-6 text-red-500" aria-hidden />
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Couldn&apos;t load fleet monitoring</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
      </button>
    </div>
  );
}

/** Honest "no trends" panel — shows the real reason instead of an invented chart. */
function TrendUnavailable({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
      <TrendingUp className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{reason}</span>
    </div>
  );
}

/** Small pulse used while the (independent) history query is still loading. */
function TrendPending() {
  return <div className="h-[200px] animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/40" aria-busy="true" />;
}

/** One secondary trend as a labelled Sparkline card (fleet-wide series). */
function TrendSparkCard({ series }: { series: FleetHistorySeries }) {
  const latest = series.points.length > 0 ? series.points[series.points.length - 1].v : null;
  const values = series.points.map((p) => p.v);
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{series.label}</span>
        {latest !== null ? (
          <span className="text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            <AnimatedNumber value={Math.round(latest)} />
            {series.unit ? <span className="ml-0.5 font-normal text-zinc-500 dark:text-zinc-400">{series.unit}</span> : null}
          </span>
        ) : (
          <span className="text-xs text-zinc-400 dark:text-zinc-500">—</span>
        )}
      </div>
      <div className="mt-3">
        {values.length > 0 ? (
          <Sparkline data={values} width={220} height={40} />
        ) : (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">No samples in the last 24h.</p>
        )}
      </div>
    </div>
  );
}

function SiteMonitorRow({ site }: { site: FleetSiteRow }) {
  const tone = STATUS_TONE[site.status];
  const lastCheck = site.lastHealthAt ? new Date(site.lastHealthAt).toLocaleTimeString() : "—";
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
          tone.ring,
          tone.soft,
          tone.text,
        )}
      >
        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_SOLID[site.status])} aria-hidden />
        {STATUS_LABEL[site.status]}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{site.name}</p>
        <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{site.url}</p>
      </div>
      <div className="flex shrink-0 items-center gap-4 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="text-right">
          <span className="block text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {site.responseMs !== null ? `${site.responseMs} ms` : "—"}
          </span>
          round-trip
        </span>
        <span className="text-right">
          <span
            className={cn(
              "block text-sm font-medium",
              site.lastHealthOk === true
                ? "text-emerald-600 dark:text-emerald-400"
                : site.lastHealthOk === false
                  ? "text-red-600 dark:text-red-400"
                  : "text-zinc-500 dark:text-zinc-400",
            )}
          >
            {lastCheck}
          </span>
          last check
        </span>
        <span className="text-right">
          <span className="block text-sm font-medium capitalize text-zinc-900 dark:text-zinc-100">
            {site.connectorState ?? "—"}
          </span>
          connector
        </span>
      </div>
    </li>
  );
}

export function FleetMonitoring() {
  const { data, loading, error, reload } = useFleet();
  const { data: history, error: historyError } = useFleetHistory();

  if (error && !data) {
    return <MonitoringErrorCard message={error} onRetry={reload} />;
  }
  if (!data) {
    // Covers `loading && !data` (and the null-before-first-load case).
    return <MonitoringSkeleton />;
  }

  const { summary, sites, generatedAt } = data;
  const onlinePct = summary.total > 0 ? ((summary.total - summary.offline) / summary.total) * 100 : 0;

  const historyReady = history !== null || historyError !== null;
  const trendsAvailable = history?.available ?? false;
  const historyReason = resolveHistoryReason(history, historyError);

  // Round-trip: featured as the existing ResponseTimeLine chart (id → {t,ms}).
  const roundtripSeries = trendsAvailable ? history?.series.find((s) => s.id === "avg_roundtrip_ms") : undefined;
  const roundtripData = (roundtripSeries?.points ?? []).map((p) => ({
    t: new Date(p.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    ms: Math.round(p.v),
  }));
  // Everything else → uniform Sparkline cards.
  const otherSeries = trendsAvailable ? (history?.series.filter((s) => s.id !== "avg_roundtrip_ms") ?? []) : [];

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Last-checked + refresh (real generatedAt from the live hook) */}
      <motion.div
        variants={riseItem}
        className="flex items-center justify-end gap-2 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <span>Last checked {new Date(generatedAt).toLocaleTimeString()}</span>
        <button
          type="button"
          onClick={reload}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} aria-hidden /> Refresh
        </button>
      </motion.div>

      {/* Current fleet stats (from the live useFleet summary) */}
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Sites online" value={onlinePct} decimals={1} suffix="%" icon={Activity} tone={healthTone(onlinePct)} />
        <StatTile label="Healthy" value={summary.healthy} icon={CheckCircle2} tone={STATUS_TONE.healthy} />
        <StatTile label="Connected links" value={summary.connected} icon={Link2} />
        <StatTile label="Updates pending" value={summary.updatesPending} icon={ArrowUpCircle} />
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Fleet round-trip — current headline (summary) + 24h trend (history) */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Fleet round-trip"
            description="Mean signed health-check round-trip across connected links, last 24 hours."
            icon={Timer}
          >
            <div className="flex items-baseline gap-2">
              {summary.avgResponse !== null ? (
                <AnimatedNumber
                  value={summary.avgResponse}
                  suffix=" ms"
                  className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
                />
              ) : (
                <span className="text-3xl font-semibold tabular-nums text-zinc-400 dark:text-zinc-500">—</span>
              )}
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                current avg · {summary.connected} link{summary.connected === 1 ? "" : "s"}
              </span>
            </div>
            <div className="mt-4">
              {!historyReady ? (
                <TrendPending />
              ) : trendsAvailable && roundtripData.length > 0 ? (
                <ResponseTimeLine data={roundtripData} />
              ) : trendsAvailable ? (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">No round-trip samples in the last 24h.</p>
              ) : (
                <TrendUnavailable reason={historyReason} />
              )}
            </div>
          </SectionCard>
        </motion.div>

        {/* Secondary fleet trends — Sparkline per series */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Fleet trends"
            description="Connector availability and command throughput across the fleet, last 24 hours."
            icon={TrendingUp}
          >
            {!historyReady ? (
              <TrendPending />
            ) : trendsAvailable ? (
              otherSeries.length > 0 ? (
                <div className="grid gap-3">
                  {otherSeries.map((s) => (
                    <TrendSparkCard key={s.id} series={s} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">No trend series in the last 24h.</p>
              )
            ) : (
              <TrendUnavailable reason={historyReason} />
            )}
          </SectionCard>
        </motion.div>
      </div>

      {/* Per-site monitoring list (live, from data.sites) */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="Per-site monitoring"
          description="Live status, last signed round-trip, last health check and connector state for every managed site."
          icon={Activity}
        >
          {sites.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites yet.</p>
          ) : (
            <ul className="space-y-2">
              {sites.map((site) => (
                <SiteMonitorRow key={site.id} site={site} />
              ))}
            </ul>
          )}
        </SectionCard>
      </motion.div>
    </motion.div>
  );
}
