"use client";

// Uptime tab for the per-site "Manage" demo console — SLA, 90-day strip, regional checks, incidents.
import { Activity, CalendarDays, ExternalLink, Globe, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageExt, UptimeData } from "../site-manage-ext-data";
import { SectionCard, UptimeStrip } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
} as const;
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

const STATUS_TONE: Readonly<Record<UptimeData["status"], { cls: string; label: string }>> = {
  operational: { cls: TONE.good, label: "Operational" },
  degraded: { cls: TONE.warn, label: "Degraded" },
  down: { cls: TONE.critical, label: "Down" },
};

export function UptimePanel({ ext }: { ext: SiteManageExt; site: string }) {
  const u = ext.uptime;
  const status = STATUS_TONE[u.status];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="Status" description="Current availability and 30-day SLA." icon={Activity} action={<DummyBadge />}>
        <div className="flex items-center justify-between">
          <span className={cn(PILL, status.cls)}>{status.label}</span>
          <DummyBadge />
        </div>
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{u.slaPct}%</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">30-day SLA</p>
        </div>
        <p className="mt-3 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{u.statusPageUrl}</p>
        <button type="button" onClick={demo} className={`${BTN} mt-3 w-full justify-center`}>
          <ExternalLink className="h-4 w-4" aria-hidden /> View public status page
        </button>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="90-day uptime"
        description="Daily availability over the last quarter."
        icon={CalendarDays}
        action={<DummyBadge />}
      >
        <UptimeStrip days={u.days90} />
      </SectionCard>

      <SectionCard title="Regional checks" description="Latency from global probe locations." icon={Globe} action={<DummyBadge />}>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Region</th>
                <th className="py-2 pr-4 text-right font-medium">Latency</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {u.regions.map((rc) => (
                <tr key={rc.region} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4">{rc.region}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{rc.ms} ms</td>
                  <td className="py-2">
                    <span className={cn(PILL, rc.up ? TONE.good : TONE.critical)}>{rc.up ? "Up" : "Down"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard
        className="lg:col-span-2"
        title="Incident history"
        description="Recent availability incidents and their impact."
        icon={TriangleAlert}
        action={<DummyBadge />}
      >
        <ul className="space-y-2">
          {u.incidents.map((inc) => (
            <li
              key={inc.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{inc.cause}</p>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {inc.started} · {inc.duration}
                </p>
              </div>
              <span className={cn(PILL, inc.impact === "major" ? TONE.critical : TONE.warn)}>
                {inc.impact === "major" ? "Major" : "Minor"}
              </span>
              <span className={cn(PILL, inc.resolved ? TONE.good : TONE.warn)}>
                {inc.resolved ? "Resolved" : "Ongoing"}
              </span>
            </li>
          ))}
        </ul>
      </SectionCard>
    </div>
  );
}
