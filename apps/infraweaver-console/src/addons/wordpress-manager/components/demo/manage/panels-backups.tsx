"use client";
// Backups panel — backup plan, size trend and restore points (demo, fake data).

import { Archive, CalendarClock, Cloud, Copy, Database, Download, History, Lock, RotateCcw, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { RestoreRow, SiteManageData } from "../site-manage-data";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { BackupAreaChart } from "../charts";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY =
  "inline-flex items-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 dark:text-white";
const BTN_SM =
  "inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  sky: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

const TYPE_BADGE: Readonly<Record<RestoreRow["type"], { label: string; tone: keyof typeof TONE_PILL }>> = {
  automatic: { label: "Automatic", tone: "neutral" },
  manual: { label: "Manual", tone: "sky" },
  "pre-update": { label: "Pre-update", tone: "amber" },
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("mt-1 text-sm text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[13px] tabular-nums")}>{value}</p>
    </div>
  );
}

export function BackupsPanel({ data }: { data: SiteManageData; site: string }) {
  const b = data.backup;
  const restoreDemo = () => toast.info("Demo — no changes are made to the live site.");

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
        <StatTile label="Retention" value={b.retentionDays} suffix=" days" icon={CalendarClock} tone={healthTone(b.retentionDays >= 30 ? 92 : b.retentionDays >= 14 ? 74 : 55)} />
        <StatTile label="Restore points" value={data.restorePoints.length} icon={History} tone={healthTone(data.restorePoints.length >= 5 ? 90 : data.restorePoints.length >= 3 ? 74 : 50)} />
        <StatTile label="Backups this month" value={data.report.backupsTaken} icon={Archive} tone={healthTone(88)} />
      </div>

      <SectionCard title="Backup plan" description="Schedule, destination and protection." icon={Archive} action={<DummyBadge />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Frequency" value={b.frequency} />
          <Field label="Retention" value={`${b.retentionDays} days`} />
          <Field label="Destination" value={b.destination} mono />
          <Field label="Next run" value={b.nextRun} />
          <Field label="Last run" value={`${b.lastRun} · ${b.lastSize}`} />
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
            {b.encrypted ? (
              <span className={cn(PILL, TONE_PILL.good)}>
                <Lock className="h-3.5 w-3.5" aria-hidden /> Encrypted
              </span>
            ) : null}
            {b.offsite ? (
              <span className={cn(PILL, TONE_PILL.sky)}>
                <Cloud className="h-3.5 w-3.5" aria-hidden /> Off-site
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={BTN_PRIMARY} onClick={() => toast.success("Demo — an on-demand backup would start now.")}>
            <Zap className="h-4 w-4" aria-hidden /> Back up now
          </button>
          <button type="button" className={BTN} onClick={() => toast.info("Demo — the backup schedule editor would open.")}>
            <CalendarClock className="h-4 w-4" aria-hidden /> Edit schedule
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Backup size trend" description="Stored backup size, last 7 days." icon={Database} action={<DummyBadge />}>
        <BackupAreaChart data={data.backupSizeTrend} />
      </SectionCard>

      <SectionCard title="Restore points" description="Recoverable snapshots on file." icon={History} action={<DummyBadge />} className="lg:col-span-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-3 font-medium">When</th>
                <th className="py-2 pr-3 font-medium">Size</th>
                <th className="py-2 pr-3 font-medium">Type</th>
                <th className="py-2 pr-3 font-medium">Trigger</th>
                <th className="py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.restorePoints.map((rp) => {
                const badge = TYPE_BADGE[rp.type];
                return (
                  <tr key={rp.id}>
                    <td className="py-2 pr-3 text-zinc-900 dark:text-zinc-100">{rp.when}</td>
                    <td className="py-2 pr-3 font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">{rp.size}</td>
                    <td className="py-2 pr-3">
                      <span className={cn(PILL, TONE_PILL[badge.tone])}>{badge.label}</span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{rp.trigger}</td>
                    <td className="py-2">
                      <div className="flex gap-1.5">
                        <button type="button" className={BTN_SM} onClick={restoreDemo}>
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore
                        </button>
                        <button type="button" className={BTN_SM} onClick={() => toast.info(`Demo — ${rp.when} backup would download.`)}>
                          <Download className="h-3.5 w-3.5" aria-hidden /> Download
                        </button>
                        <button type="button" className={BTN_SM} onClick={() => toast.info("Demo — a staging clone would be spun up.")}>
                          <Copy className="h-3.5 w-3.5" aria-hidden /> Clone → staging
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
