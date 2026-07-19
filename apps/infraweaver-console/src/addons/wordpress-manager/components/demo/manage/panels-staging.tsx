"use client";
// Staging & Deploys panel — WP Staging clones read live from the plugin's option store.

import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StagingClone, StagingData } from "../../../lib/manage/probes/staging";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

/** WP Staging clone status → pill tone (finished clones are the healthy case). */
function statusTone(status: string): string {
  const s = status.toLowerCase();
  if (s === "finished" || s === "complete") return TONE.good;
  if (s === "failed" || s === "error") return TONE.warn;
  return TONE.neutral;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300 break-all">{value}</dd>
    </div>
  );
}

function CloneCard({ clone }: { clone: StagingClone }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(PILL, TONE.info)}>{clone.name}</span>
        {clone.status ? <span className={cn(PILL, statusTone(clone.status))}>{clone.status}</span> : null}
        {clone.datetime ? <span className="text-xs text-zinc-500">created {formatDate(clone.datetime)}</span> : null}
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        {clone.url ? <Detail label="URL" value={clone.url} /> : null}
        {clone.path ? <Detail label="Path" value={clone.path} /> : null}
        {clone.dbname ? <Detail label="Database" value={clone.dbname} /> : null}
        {clone.prefix ? <Detail label="Table prefix" value={clone.prefix} /> : null}
      </dl>
    </div>
  );
}

export function StagingPanel({ site }: { site: string }) {
  const state = useManagePanel<StagingData>(site, "staging");

  return (
    <PanelState
      state={state}
      isEmpty={(data) => data.clones.length === 0}
      emptyMessage="No staging clones on this site yet."
    >
      {(data) => (
        <div className="grid gap-5">
          <SectionCard
            title="Staging clones"
            description={`${data.clones.length} clone${data.clones.length === 1 ? "" : "s"} registered by WP Staging.`}
            icon={GitBranch}
          >
            <div className="space-y-3">
              {data.clones.map((clone) => (
                <CloneCard key={clone.name} clone={clone} />
              ))}
            </div>
          </SectionCard>
        </div>
      )}
    </PanelState>
  );
}
