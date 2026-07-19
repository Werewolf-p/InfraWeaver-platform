"use client";

// Staging & Deploys tab for the per-site "Manage" demo console — environments and deployment history.
import { ArrowDown, ArrowUp, GitBranch, History, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { DeployRow, SiteManageExt } from "../site-manage-ext-data";
import { SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 dark:text-white";

const demo = () => toast.info("Demo — no changes are made to the live site.");

const STATUS_TONE: Readonly<Record<DeployRow["status"], string>> = {
  success: TONE.good,
  failed: TONE.critical,
  running: TONE.warn,
};

export function StagingPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { staging } = ext;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="Environments" description="Staging copies of this site." icon={GitBranch} action={<DummyBadge />}>
        {!staging.hasStaging ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            <p>No staging environment yet. Spin one up to test changes safely before they go live.</p>
            <button type="button" onClick={demo} className={cn(BTN, "mx-auto mt-3")}>
              <Plus className="h-4 w-4" aria-hidden /> Create staging site
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {staging.envs.map((env) => (
              <div key={env.name} className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn(PILL, TONE.info)}>{env.name}</span>
                  <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{env.url}</span>
                  <span className="text-xs text-zinc-500">synced {env.lastSynced}</span>
                  <span className={cn(PILL, env.phpMatchesProd ? TONE.good : TONE.warn)}>
                    {env.phpMatchesProd ? "PHP matches prod" : "PHP drift"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                  ahead: <span className="tabular-nums">{env.aheadFiles}</span> files ·{" "}
                  <span className="tabular-nums">{env.aheadDbRows.toLocaleString("en-US")}</span> rows
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={demo} className={BTN_PRIMARY}>
                    <ArrowUp className="h-4 w-4" aria-hidden /> Push to production
                  </button>
                  <button type="button" onClick={demo} className={BTN}>
                    <ArrowDown className="h-4 w-4" aria-hidden /> Pull from production
                  </button>
                  <button type="button" onClick={demo} className={BTN}>
                    <RefreshCw className="h-4 w-4" aria-hidden /> Sync from prod
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Deployment history"
        description="Recent pushes and pulls between environments."
        icon={History}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Direction</th>
                <th className="py-2 pr-4 font-medium">Scope</th>
                <th className="py-2 pr-4 font-medium">By</th>
                <th className="py-2 pr-4 font-medium">Commit</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {staging.deploys.map((d) => (
                <tr key={d.id} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">{d.when}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, d.direction === "push-to-prod" ? TONE.info : TONE.neutral)}>
                      {d.direction === "push-to-prod" ? "push to prod" : "pull from prod"}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL, TONE.neutral)}>{d.scope}</span>
                  </td>
                  <td className="py-2 pr-4">{d.by}</td>
                  <td className="py-2 pr-4 font-mono text-[11px]">{d.commit}</td>
                  <td className="py-2">
                    <span className={cn(PILL, STATUS_TONE[d.status])}>{d.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
