"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  FileText,
  History,
  Info,
  Link2,
  PackageCheck,
  RefreshCw,
  ServerCrash,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetSiteRow, FleetSiteStatus } from "../../lib/fleet/types";
import { riseItem, staggerContainer } from "./motion";
import { useFleet } from "./use-fleet";
import { SectionCard, STATUS_LABEL, STATUS_TONE } from "./widgets";

// ── Real derivations (no seeded/fake data) ───────────────────────────────────
function pendingOf(row: FleetSiteRow): number {
  return row.updates.core + row.updates.plugins + row.updates.themes;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never checked";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never checked" : d.toLocaleString();
}

interface ActivityEntry {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly when: string;
  readonly whenMs: number;
  readonly status: FleetSiteStatus;
}

/** Build a real activity list from live per-site signals — no invented events. */
function deriveActivity(rows: readonly FleetSiteRow[]): ActivityEntry[] {
  return rows
    .map((row) => {
      const parts: string[] = [];
      if (row.connectorState) parts.push(`connector ${row.connectorState}`);
      const pending = pendingOf(row);
      if (pending > 0) parts.push(`${pending} update${pending === 1 ? "" : "s"} pending`);
      if (row.health !== null) parts.push(`health ${row.health}`);
      if (row.offline) parts.push("offline");
      if (row.rejections > 0) parts.push(`${row.rejections} rejection${row.rejections === 1 ? "" : "s"}`);
      if (parts.length === 0) parts.push(row.lastHealthOk ? "health check passed" : STATUS_LABEL[row.status]);
      const t = row.lastHealthAt ? new Date(row.lastHealthAt).getTime() : NaN;
      return {
        id: row.id,
        name: row.name,
        detail: parts.join(" · "),
        when: formatWhen(row.lastHealthAt),
        whenMs: Number.isNaN(t) ? -1 : t,
        status: row.status,
      };
    })
    .sort((a, b) => b.whenMs - a.whenMs);
}

const ACTIVITY_ICON: Readonly<Record<FleetSiteStatus, React.ElementType>> = {
  healthy: CheckCircle2,
  attention: AlertTriangle,
  critical: ServerCrash,
  offline: ServerCrash,
};

// ── Loading / error states (mirrors fleet-overview.tsx) ───────────────────────
function ReportsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="h-40 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
        <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      </div>
    </div>
  );
}

function ReportsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <ServerCrash className="mx-auto h-6 w-6 text-red-500" aria-hidden />
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Couldn&apos;t load the report</p>
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

export function FleetReports() {
  const { data, loading, error, reload } = useFleet();

  if (error && !data) {
    return <ReportsError message={error} onRetry={reload} />;
  }
  if (!data) {
    return <ReportsSkeleton />;
  }

  const { summary, sites, generatedAt } = data;
  const attention = summary.attention + summary.critical;
  const allHealthy = summary.critical === 0 && summary.offline === 0 && summary.attention === 0;

  const reportStats: ReadonlyArray<{ label: string; value: number }> = [
    { label: "Sites managed", value: summary.total },
    { label: "Healthy", value: summary.healthy },
    { label: "Need attention", value: attention },
    { label: "Offline", value: summary.offline },
    { label: "Updates pending", value: summary.updatesPending },
    { label: "Connected links", value: summary.connected },
  ];

  const sitesWithUpdates = sites
    .filter((s) => pendingOf(s) > 0)
    .sort((a, b) => pendingOf(b) - pendingOf(a));
  const activity = deriveActivity(sites);

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Real client-report roll-up, sourced entirely from the live fleet signals */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="Client report"
          description="Shareable white-label summary — a client's-eye view built from live fleet signals."
          icon={FileText}
          action={
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} aria-hidden /> Refresh
            </button>
          }
        >
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-4 dark:border-zinc-800 dark:bg-zinc-950/50">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-sky-500/15 text-sm font-bold text-sky-600 dark:text-sky-400">IW</span>
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Fleet care report</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    As of {new Date(generatedAt).toLocaleString()} · prepared by InfraWeaver
                  </p>
                </div>
              </div>
              {allHealthy ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> All systems healthy
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {attention + summary.offline} site
                  {attention + summary.offline === 1 ? "" : "s"} need attention
                </span>
              )}
            </div>
            <div className="grid gap-px bg-zinc-200 dark:bg-zinc-800 sm:grid-cols-3">
              {reportStats.map((stat) => (
                <div key={stat.label} className="bg-white p-4 dark:bg-zinc-900/60">
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{stat.label}</p>
                  <span className="mt-1 block text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {stat.value}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-zinc-200 bg-white px-5 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
              <span>
                Avg round-trip{" "}
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  {summary.avgResponse !== null ? `${summary.avgResponse} ms` : "—"}
                </span>{" "}
                across {summary.connected} connected link{summary.connected === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {/* Honest disclosure: figures with no secure source are NOT fabricated */}
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
            <p>
              Visitor/traffic totals and threats-blocked are not shown here — they need a traffic-analytics and
              WAF/security integration. Uptime history comes from Prometheus (Monitoring tab). Nothing on this report is
              estimated or filled in with placeholder numbers.
            </p>
          </div>
        </SectionCard>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        {/* Pending updates — real per-site counts from the live rows */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Pending updates"
            description="Core, plugin and theme updates awaiting each managed site."
            icon={ArrowUpCircle}
          >
            {sitesWithUpdates.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
                <PackageCheck className="h-4 w-4 shrink-0" aria-hidden /> Every managed site is up to date.
              </div>
            ) : (
              <ul className="space-y-3">
                {sitesWithUpdates.map((site) => {
                  const total = pendingOf(site);
                  return (
                    <li
                      key={site.id}
                      className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{site.name}</p>
                          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{site.url}</p>
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                          {total} pending
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                        <span>Core: <span className="font-medium text-zinc-800 dark:text-zinc-200">{site.updates.core}</span></span>
                        <span>Plugins: <span className="font-medium text-zinc-800 dark:text-zinc-200">{site.updates.plugins}</span></span>
                        <span>Themes: <span className="font-medium text-zinc-800 dark:text-zinc-200">{site.updates.themes}</span></span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
        </motion.div>

        {/* Activity — derived from live per-site state, timestamped by lastHealthAt only */}
        <motion.div variants={riseItem}>
          <SectionCard
            title="Activity log"
            description="Current state of every managed site, most recently checked first."
            icon={History}
          >
            {activity.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites yet.</p>
            ) : (
              <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-zinc-200 dark:before:bg-zinc-800">
                {activity.map((item) => {
                  const Icon = ACTIVITY_ICON[item.status];
                  const tone = STATUS_TONE[item.status];
                  return (
                    <li key={item.id} className="relative flex gap-3">
                      <span className="z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                        <Icon className={cn("h-4 w-4", tone.text)} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1 pt-1">
                        <p className="flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100">
                          <Link2 className="h-3.5 w-3.5 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
                          <span className="truncate font-medium">{item.name}</span>
                        </p>
                        <p className="text-xs text-zinc-600 dark:text-zinc-400">{item.detail}</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-500">Last checked {item.when}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
