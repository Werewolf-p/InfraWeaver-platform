"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ShieldAlert, ShieldCheck, ShieldX, Clock, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { AnimatedNumber, FilterSelect, HelpTooltip } from "@/components/ui";
import { useApiQuery } from "@/hooks/use-api-query";
import { drSeverity, type CoverageStatus, type CoverageSummary, type OrphanBackup, type PvcCoverageRow } from "@/lib/dr/coverage";
import { RestoreDrills } from "./_components/restore-drills";

interface CoverageResponse {
  available: boolean;
  reason?: string;
  rows?: PvcCoverageRow[];
  summary?: CoverageSummary;
  orphans?: OrphanBackup[];
  rpoTargetHours?: number;
}

const STATUS_META: Record<CoverageStatus, { label: string; className: string; icon: typeof ShieldCheck }> = {
  protected: { label: "Protected", className: "bg-green-500/10 text-green-500 dark:text-green-400 border-green-500/20", icon: ShieldCheck },
  stale: { label: "Stale (RPO breach)", className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20", icon: Clock },
  "no-schedule": { label: "No schedule", className: "bg-orange-500/10 text-orange-500 dark:text-orange-400 border-orange-500/20", icon: ShieldAlert },
  unprotected: { label: "Unprotected", className: "bg-red-500/10 text-red-500 dark:text-red-400 border-red-500/20", icon: ShieldX },
};

/** Severity order: worst first. Mirrors the pure lib's ordering. */
const STATUS_ORDER: Record<CoverageStatus, number> = { unprotected: 0, "no-schedule": 1, stale: 2, protected: 3 };

const SCORE_TONE = { ok: "text-green-500 dark:text-green-400", warning: "text-yellow-600 dark:text-yellow-400", critical: "text-red-500 dark:text-red-400" } as const;

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "at-risk", label: "At-risk only" },
  { value: "unprotected", label: "Unprotected" },
  { value: "no-schedule", label: "No schedule" },
  { value: "stale", label: "Stale (RPO breach)" },
  { value: "protected", label: "Protected" },
];

function ageLabel(hours: number | null): string {
  if (hours === null) return "Never";
  if (hours < 1) return "< 1h ago";
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Actionable fix text for an at-risk PVC — turns the report into a remediation surface. */
function remediation(row: PvcCoverageRow, rpoHours: number): string | null {
  switch (row.status) {
    case "unprotected":
      return row.isLonghorn
        ? "Longhorn volume with no completed backup. Attach a RecurringJob (task: backup) to this volume's group so it starts backing up."
        : `Not on Longhorn (${row.storageClass}) — no backup mechanism exists. Migrate this PVC onto a Longhorn StorageClass to enable DR, or accept it as ephemeral.`;
    case "no-schedule":
      return "Backups exist but no recurring job keeps them fresh. Add a Longhorn RecurringJob (task: backup) targeting this volume's group to hold the RPO.";
    case "stale": {
      const over = row.lastBackupAgeHours !== null ? Math.max(0, Math.round(row.lastBackupAgeHours - rpoHours)) : null;
      return `Last backup ${ageLabel(row.lastBackupAgeHours)} — past the ${rpoHours}h RPO${over !== null ? ` by ~${over}h` : ""}. Check the recurring-backup job's schedule and health.`;
    }
    default:
      return null;
  }
}

export function DrReadinessView() {
  const { data, isLoading } = useApiQuery<CoverageResponse>({
    queryKey: ["storage", "dr-coverage"],
    path: "/api/storage/dr/coverage",
    staleTime: 60_000,
  });

  const [statusFilter, setStatusFilter] = useState("all");

  const rpoHours = data?.rpoTargetHours ?? 24;
  const allRows = useMemo(() => {
    const rows = data?.rows ?? [];
    return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.namespace.localeCompare(b.namespace));
  }, [data?.rows]);

  const rows = useMemo(() => {
    if (statusFilter === "all") return allRows;
    if (statusFilter === "at-risk") return allRows.filter((r) => r.status !== "protected");
    return allRows.filter((r) => r.status === statusFilter);
  }, [allRows, statusFilter]);

  if (isLoading) {
    return <div className="space-y-4">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />)}</div>;
  }

  if (!data?.available) {
    return (
      <div className="rounded-xl border border-gray-200 bg-slate-100 p-8 text-center dark:border-white/10 dark:bg-slate-900/60">
        <ShieldAlert className="mx-auto mb-3 h-8 w-8 text-slate-400" />
        <p className="text-sm text-slate-500 dark:text-slate-400">Longhorn is unreachable — backup coverage cannot be assessed.</p>
      </div>
    );
  }

  const summary = data.summary;
  const orphans = data.orphans ?? [];
  const score = summary?.score ?? 100;
  const severity = drSeverity(score);
  const tone = SCORE_TONE[severity];
  const atRisk = (summary?.unprotected ?? 0) + (summary?.stale ?? 0) + (summary?.noSchedule ?? 0);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={ShieldCheck} title="DR Readiness" description={`Backup coverage for every persistent volume · RPO target ${rpoHours}h`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 text-center backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
          <p className="text-xs text-slate-500 dark:text-slate-400">DR readiness</p>
          <p className={cn("mt-1 text-3xl font-bold tabular-nums", tone)}>
            <AnimatedNumber value={score} />
            <span className="text-base text-slate-500">/100</span>
          </p>
          <p className={cn("mt-0.5 text-[11px] font-medium", tone)}>{severity === "ok" ? "Healthy" : severity === "warning" ? "Needs attention" : "Critical"}</p>
        </div>
        {[
          { label: "Coverage", value: `${summary?.coveragePct ?? 0}%`, color: "text-gray-900 dark:text-white" },
          { label: "Unprotected", value: `${summary?.unprotected ?? 0}`, color: (summary?.unprotected ?? 0) > 0 ? "text-red-500 dark:text-red-400" : "text-green-500 dark:text-green-400" },
          { label: "Stale (>RPO)", value: `${summary?.stale ?? 0}`, color: (summary?.stale ?? 0) > 0 ? "text-yellow-600 dark:text-yellow-400" : "text-green-500 dark:text-green-400" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-200 bg-slate-100 p-4 text-center backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
            <p className="text-xs text-slate-500 dark:text-slate-400">{c.label}</p>
            <p className={cn("mt-1 text-3xl font-bold tabular-nums", c.color)}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />≥85 healthy</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-yellow-500" aria-hidden="true" />60–84 warning</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />&lt;60 critical</span>
        </p>
        <div className="flex items-center gap-2">
          {atRisk > 0 ? <span className="text-xs text-slate-500 dark:text-slate-400">{atRisk} at-risk of {allRows.length}</span> : null}
          <FilterSelect label="Filter by backup status" value={statusFilter} options={STATUS_FILTER_OPTIONS} onChange={setStatusFilter} />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-slate-100 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10">
                {["Volume Claim", "Namespace", "Storage Class", "Capacity", "Last Backup", "Status", ""].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = STATUS_META[row.status];
                const Icon = meta.icon;
                const fix = remediation(row, rpoHours);
                return (
                  <tr key={`${row.namespace}/${row.name}`} className={cn("border-b border-gray-200 transition-colors hover:bg-gray-100 dark:border-white/5 dark:hover:bg-white/5", row.status === "unprotected" && "bg-red-500/[0.04] dark:bg-red-500/5")}>
                    <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">{row.name}</td>
                    <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{row.namespace}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600 dark:text-slate-300">{row.storageClass}</td>
                    <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-300">{row.capacity}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{ageLabel(row.lastBackupAgeHours)}</td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs", meta.className)}>
                        <Icon className="h-3 w-3" />
                        {meta.label}
                      </span>
                    </td>
                    <td className="px-2 py-3">
                      {fix ? <HelpTooltip>{fix}</HelpTooltip> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <div className="py-12 text-center text-sm text-slate-500">
            {allRows.length === 0 ? "No persistent volume claims found" : "No volumes match this filter"}
          </div>
        )}
      </div>

      <RestoreDrills />

      {orphans.length > 0 && (
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-orange-500 dark:text-orange-400">
            <Archive className="h-4 w-4" />
            {orphans.length} orphaned backup{orphans.length > 1 ? "s" : ""} — source volume/PVC deleted, still consuming target storage
          </p>
          <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
            {orphans.map((o) => (
              <li key={o.volumeName} className="font-mono">{o.volumeName} · last backup {ageLabel(o.ageHours)}</li>
            ))}
          </ul>
        </div>
      )}
    </motion.div>
  );
}
