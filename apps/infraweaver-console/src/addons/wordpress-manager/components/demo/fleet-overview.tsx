"use client";

import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Layers,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetSiteRow, FleetSiteStatus } from "../../lib/fleet/types";
import { riseItem, staggerContainer } from "./motion";
import { useFleet } from "./use-fleet";
import {
  HealthGauge,
  SectionCard,
  StatTile,
  STATUS_LABEL,
  STATUS_TONE,
} from "./widgets";

// Solid status colours for dots and the distribution bar (Tailwind classes,
// not a new widget). Keyed by the same union the widgets' STATUS_TONE uses.
const STATUS_SOLID: Readonly<Record<FleetSiteStatus, string>> = {
  healthy: "bg-emerald-500",
  attention: "bg-amber-500",
  critical: "bg-red-500",
  offline: "bg-zinc-400",
};

const STATUS_ORDER: readonly FleetSiteStatus[] = ["healthy", "attention", "critical", "offline"];

const SKELETON_TILES: readonly number[] = [0, 1, 2, 3];

/** Honest, real-signal reasons a site needs attention — no invented severities. */
function attentionReasons(row: FleetSiteRow): string[] {
  const reasons: string[] = [];
  const pending = row.updates.core + row.updates.plugins + row.updates.themes;
  if (row.offline) reasons.push("offline");
  if (pending > 0) reasons.push(`${pending} update${pending === 1 ? "" : "s"} pending`);
  if (row.health !== null) reasons.push(`health ${row.health}`);
  if (row.connectorState) reasons.push(`connector ${row.connectorState}`);
  if (row.rejections > 0) reasons.push(`${row.rejections} rejection${row.rejections === 1 ? "" : "s"}`);
  return reasons;
}

function FleetSkeleton() {
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
      <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
        <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      </div>
    </div>
  );
}

function FleetErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <ServerCrash className="mx-auto h-6 w-6 text-red-500" aria-hidden />
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Couldn&apos;t load the fleet</p>
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

export function FleetOverview() {
  const { data, loading, error, reload } = useFleet();

  if (error && !data) {
    return <FleetErrorCard message={error} onRetry={reload} />;
  }
  if (!data) {
    // Covers `loading && !data` (and the null-before-first-load case).
    return <FleetSkeleton />;
  }

  const { summary, sites, generatedAt } = data;
  const attentionCount = summary.attention + summary.critical;
  const statusCounts: Readonly<Record<FleetSiteStatus, number>> = {
    healthy: summary.healthy,
    attention: summary.attention,
    critical: summary.critical,
    offline: summary.offline,
  };
  const attentionRows = sites.filter(
    (s) => s.status === "critical" || s.status === "attention" || s.status === "offline",
  );

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Last-checked + refresh affordance (real generatedAt from the hook) */}
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

      {/* Fleet stat tiles */}
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Sites managed" value={summary.total} icon={Layers} />
        <StatTile label="Healthy" value={summary.healthy} icon={CheckCircle2} tone={STATUS_TONE.healthy} />
        <StatTile
          label="Need attention"
          value={attentionCount}
          icon={AlertTriangle}
          tone={STATUS_TONE.attention}
        />
        <StatTile label="Updates pending" value={summary.updatesPending} icon={ArrowUpCircle} />
      </motion.div>

      {/* All-sites health grid */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="All-sites health"
          description="Composite Site-Health score, signed round-trip and pending work for every managed site."
          icon={Gauge}
        >
          {sites.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites yet.</p>
          ) : (
            <motion.ul
              variants={staggerContainer}
              initial="hidden"
              animate="show"
              className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]"
            >
              {sites.map((site) => {
                const tone = STATUS_TONE[site.status];
                const pending = site.updates.core + site.updates.plugins + site.updates.themes;
                return (
                  <motion.li
                    key={site.id}
                    variants={riseItem}
                    className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{site.name}</p>
                        <span className="mt-0.5 inline-flex max-w-full items-center gap-1 truncate text-xs text-zinc-500 dark:text-zinc-400">
                          {site.url} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                        </span>
                      </div>
                      {site.health !== null ? (
                        <HealthGauge score={site.health} size={56} strokeWidth={6} />
                      ) : (
                        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full border border-dashed border-zinc-300 text-xs text-zinc-400 dark:border-zinc-700">
                          —
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          tone.ring,
                          tone.soft,
                          tone.text,
                        )}
                      >
                        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_SOLID[site.status])} aria-hidden />
                        {STATUS_LABEL[site.status]}
                      </span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                        {site.responseMs !== null ? `${site.responseMs} ms` : "—"} · {pending} update
                        {pending === 1 ? "" : "s"}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>PHP {site.php ?? "—"}</span>
                      <span>Connector {site.connectorVersion ?? "—"}</span>
                    </div>
                  </motion.li>
                );
              })}
            </motion.ul>
          )}
        </SectionCard>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Fleet status distribution — real counts from summary (replaces the fake trend chart) */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Fleet status"
            description="Live status distribution across every managed site."
            icon={Activity}
          >
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              {summary.total > 0
                ? STATUS_ORDER.map((s) => {
                    const count = statusCounts[s];
                    if (count === 0) return null;
                    return (
                      <div
                        key={s}
                        className={STATUS_SOLID[s]}
                        style={{ width: `${(count / summary.total) * 100}%` }}
                        title={`${STATUS_LABEL[s]}: ${count}`}
                      />
                    );
                  })
                : null}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STATUS_ORDER.map((s) => (
                <div
                  key={s}
                  className="rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-950/40"
                >
                  <span className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                    <span className={cn("h-2 w-2 rounded-full", STATUS_SOLID[s])} aria-hidden />
                    {STATUS_LABEL[s]}
                  </span>
                  <span className="mt-1 block text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {statusCounts[s]}
                  </span>
                </div>
              ))}
            </div>

            <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
              Avg round-trip {summary.avgResponse !== null ? `${summary.avgResponse} ms` : "—"} across{" "}
              {summary.connected} connected link{summary.connected === 1 ? "" : "s"}.
            </p>
            <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
              Historical trends come from Prometheus (Monitoring tab).
            </p>
          </SectionCard>
        </motion.div>

        {/* Global attention feed — derived from the real worst-first rows */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Attention feed"
            description="Sites needing action, most urgent first — derived from live signals."
            icon={ShieldAlert}
          >
            {attentionRows.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> All managed sites are healthy.
              </div>
            ) : (
              <ul className="space-y-2">
                {attentionRows.map((row) => {
                  const reasons = attentionReasons(row);
                  const tone = STATUS_TONE[row.status];
                  const isCritical = row.status === "critical" || row.status === "offline";
                  return (
                    <li
                      key={row.id}
                      className="flex items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40"
                    >
                      <span className="mt-0.5">
                        {isCritical ? (
                          <ServerCrash className="h-4 w-4 text-red-500" aria-hidden />
                        ) : (
                          <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-zinc-900 dark:text-zinc-100">{row.name}</p>
                        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                          {reasons.length > 0 ? reasons.join(" · ") : STATUS_LABEL[row.status]}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          tone.ring,
                          tone.soft,
                          tone.text,
                        )}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
