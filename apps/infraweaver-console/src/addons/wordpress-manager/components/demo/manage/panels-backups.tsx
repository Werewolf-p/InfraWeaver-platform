"use client";
// Backups panel — backup posture read live from the site's active backup plugin.

import { Archive, CalendarClock, CheckCircle2, Clock, Database, History, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BackupsData } from "../../../lib/manage/probes/backups";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;

/** UpdraftPlus `updraft_interval` machine values → readable schedule labels. */
const SCHEDULE_LABEL: Readonly<Record<string, string>> = {
  manual: "Manual only",
  everyhour: "Hourly",
  every2hours: "Every 2 hours",
  every4hours: "Every 4 hours",
  every8hours: "Every 8 hours",
  every12hours: "Every 12 hours",
  daily: "Daily",
  twicedaily: "Twice daily",
  weekly: "Weekly",
  fortnightly: "Fortnightly",
  monthly: "Monthly",
};

function scheduleLabel(raw: string | null): string {
  if (!raw) return "—";
  return SCHEDULE_LABEL[raw] ?? raw;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("mt-1 text-sm text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[13px] tabular-nums")}>{value}</p>
    </div>
  );
}

export function BackupsPanel({ site }: { site: string }) {
  const state = useManagePanel<BackupsData>(site, "backups");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
            <StatTile
              label="Retention sets"
              value={data.retainSets ?? 0}
              icon={CalendarClock}
              tone={healthTone((data.retainSets ?? 0) >= 5 ? 90 : (data.retainSets ?? 0) >= 2 ? 72 : 50)}
            />
            <StatTile
              label="Backup files"
              value={data.files.length}
              icon={History}
              tone={healthTone(data.files.length > 0 ? 88 : 45)}
            />
            <StatTile label="Stored size" value={data.totalMb ?? 0} suffix=" MB" icon={Database} tone={healthTone(60)} />
          </div>

          <SectionCard
            title="Backup plan"
            description={data.plugin ? `Reported by ${data.plugin}.` : "Active backup plugin."}
            icon={Archive}
            className="lg:col-span-2"
          >
            {data.updraft ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Plugin" value={data.plugin ?? "—"} mono />
                <Field label="Schedule" value={scheduleLabel(data.schedule)} />
                <Field label="Retention" value={data.retainSets != null ? `${data.retainSets} sets` : "—"} />
                <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wide text-zinc-500">Last backup</p>
                    <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100">
                      <Clock className="h-3.5 w-3.5 text-zinc-400" aria-hidden /> {formatDate(data.lastBackupAt)}
                    </p>
                  </div>
                  {data.lastBackupOk === null ? null : data.lastBackupOk ? (
                    <span className={cn(PILL, TONE_PILL.good)}>
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> OK
                    </span>
                  ) : (
                    <span className={cn(PILL, TONE_PILL.critical)}>
                      <XCircle className="h-3.5 w-3.5" aria-hidden /> Errors
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                <p>
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{data.plugin ?? "A backup plugin"}</span> is
                  active. Detailed schedule, retention and restore-point introspection is available for UpdraftPlus; other
                  backup plugins are reported as active only.
                </p>
              </div>
            )}
          </SectionCard>

          {data.files.length > 0 ? (
            <SectionCard
              title="Backup files"
              description="Stored archives on disk, largest first."
              icon={History}
              className="lg:col-span-2"
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-3 font-medium">File</th>
                      <th className="py-2 font-medium text-right">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.files.map((f) => (
                      <tr key={f.file}>
                        <td className="py-2 pr-3 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{f.file}</td>
                        <td className="py-2 text-right font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                          {f.mb} MB
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </div>
      )}
    </PanelState>
  );
}
