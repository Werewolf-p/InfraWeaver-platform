"use client";
// Backups panel — a READ-ONLY backup POSTURE report read live from the site's
// active backup plugin. There is no allow-listed "run backup" or "restore" action,
// so this panel renders no mutation buttons: it answers one question honestly —
// "is this site actually recoverable, and how recently?" — and, when nothing is
// configured, makes the risk plain.
//
// Built on the Manage design-system kit (`./kit`): the hero verdict pairs a tone
// with a `Pill`, archives are a `DataTable`, and the no-backups state is an
// `EmptyState`.

import type { ElementType } from "react";
import { CheckCircle2, Clock, History, Info, ShieldAlert, ShieldCheck, ShieldX, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BackupFile, BackupsData } from "../../../lib/manage/probes/backups";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { DataTable, EmptyState, Pill } from "./kit";
import type { Column } from "./kit";

/** A backup older than this reads as overdue, not fresh. */
const FRESH_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Human relative age of an ISO timestamp ("3 days ago"). `now` injectable for tests. */
export function relativeAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = now - then;
  if (diffMs < 60_000) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export type PostureTone = "good" | "warn" | "critical";

export interface BackupPosture {
  readonly tone: PostureTone;
  readonly headline: string;
  readonly detail: string;
  /** Whether the last recorded run succeeded, or null when unknown/none. */
  readonly ok: boolean | null;
}

/**
 * The one thing the site owner cares about: when did we last get a good backup?
 * Fresh + ok → good; stale → warn; failed or none → critical. `now` is injectable
 * so the verdict is deterministic in tests.
 */
export function assessBackup(data: BackupsData, now: number = Date.now()): BackupPosture {
  if (!data.lastBackupAt) {
    return {
      tone: "critical",
      headline: "No backup on record",
      detail: "There is no restore point — this site can't be rolled back if something breaks.",
      ok: null,
    };
  }
  const age = relativeAge(data.lastBackupAt, now);
  if (data.lastBackupOk === false) {
    return {
      tone: "critical",
      headline: `Last backup failed ${age}`,
      detail: "The most recent run reported errors — the latest restore point may be incomplete.",
      ok: false,
    };
  }
  const when = new Date(data.lastBackupAt).getTime();
  const stale = !Number.isNaN(when) && now - when > FRESH_MAX_MS;
  if (stale) {
    return {
      tone: "warn",
      headline: `Last backup ${age}`,
      detail: "Backups are overdue — the most recent one is more than a week old.",
      ok: data.lastBackupOk,
    };
  }
  return {
    tone: "good",
    headline: `Last backup ${age}`,
    detail: "A recent restore point is available.",
    ok: data.lastBackupOk,
  };
}

const HERO_TONE: Readonly<Record<PostureTone, { wrap: string; icon: string; Icon: ElementType }>> = {
  good: {
    wrap: "border-emerald-500/30 bg-emerald-500/10",
    icon: "text-emerald-600 dark:text-emerald-400",
    Icon: ShieldCheck,
  },
  warn: {
    wrap: "border-amber-500/30 bg-amber-500/10",
    icon: "text-amber-600 dark:text-amber-400",
    Icon: ShieldAlert,
  },
  critical: {
    wrap: "border-red-500/40 bg-red-500/10",
    icon: "text-red-600 dark:text-red-400",
    Icon: ShieldX,
  },
};

function BackupHero({ posture }: { posture: BackupPosture }) {
  const tone = HERO_TONE[posture.tone];
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-5 lg:col-span-2", tone.wrap)}>
      <div className="flex items-center gap-4">
        <span className={cn("grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/60 dark:bg-zinc-950/40", tone.icon)}>
          <tone.Icon className="h-6 w-6" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Backup posture</p>
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{posture.headline}</p>
          <p className="max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{posture.detail}</p>
        </div>
      </div>
      {posture.ok === true ? (
        <Pill tone="good" icon={CheckCircle2}>
          No errors
        </Pill>
      ) : posture.ok === false ? (
        <Pill tone="critical" icon={XCircle}>
          Errors
        </Pill>
      ) : null}
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={cn("mt-1 text-sm text-zinc-900 dark:text-zinc-100", mono && "font-mono text-[13px] tabular-nums")}>{value}</p>
    </div>
  );
}

// Stored archives → shared DataTable (archive left, size right-aligned).
const FILE_COLUMNS: readonly Column<BackupFile>[] = [
  {
    key: "file",
    header: "Archive",
    render: (f) => <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{f.file}</span>,
  },
  {
    key: "mb",
    header: "Size",
    align: "right",
    render: (f) => `${f.mb} MB`,
    className: "font-mono text-[11px] text-zinc-600 dark:text-zinc-400",
  },
];

export function BackupsPanel({ site }: { site: string }) {
  const state = useManagePanel<BackupsData>(site, "backups");

  return (
    <PanelState state={state}>
      {(data) => {
        // No backup plugin at all — the agency's upsell moment. Make the risk plain.
        if (!data.plugin) {
          return (
            <EmptyState
              icon={ShieldX}
              title="No backups configured"
              body="Your site can't be restored if something breaks. Install a backup plugin — we recommend UpdraftPlus — so there's always a recent restore point."
              className="border-red-500/30"
            />
          );
        }

        // A backup plugin is active but only UpdraftPlus publishes a readable option
        // surface. For anything else, report it as active without inventing posture.
        if (!data.updraft) {
          return (
            <div className="grid gap-5">
              <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/60 text-sky-600 dark:bg-zinc-950/40 dark:text-sky-400">
                  <ShieldCheck className="h-6 w-6" aria-hidden />
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Backup posture</p>
                  <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Protected by {data.plugin}</p>
                  <p className="max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
                    {data.plugin} is active on this site. Detailed schedule, retention and last-backup status are only
                    readable for UpdraftPlus — other plugins are reported as active only.
                  </p>
                </div>
              </div>
            </div>
          );
        }

        const posture = assessBackup(data);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <BackupHero posture={posture} />

            <p className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 lg:col-span-2 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
              Read-only posture report — backups run inside WordPress, not from this console.
            </p>

            <SectionCard
              title="Backup plan"
              description={`Reported by ${data.plugin}.`}
              icon={ShieldCheck}
              className="lg:col-span-2"
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Fact label="Plugin" value={data.plugin} mono />
                <Fact label="Schedule" value={scheduleLabel(data.schedule)} />
                <Fact label="Retention" value={data.retainSets != null ? `${data.retainSets} sets` : "—"} />
                <Fact label="Stored size" value={data.totalMb != null ? `${data.totalMb} MB` : "—"} mono />
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 sm:col-span-2 lg:col-span-4 dark:border-zinc-800 dark:bg-zinc-950/40">
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">Last backup</p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-900 dark:text-zinc-100">
                    <Clock className="h-3.5 w-3.5 text-zinc-400" aria-hidden /> {formatDate(data.lastBackupAt)}
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Restore points"
              description="Backup archives stored on disk, largest first."
              icon={History}
              className="lg:col-span-2"
            >
              {data.files.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="No archives on disk"
                  body="No local backup files were found — recent restore points may live off-site with your storage provider."
                />
              ) : (
                <DataTable
                  caption="Backup archives stored on disk with their sizes"
                  columns={FILE_COLUMNS}
                  rows={data.files}
                  getRowKey={(f, index) => `${f.file}:${index}`}
                />
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
