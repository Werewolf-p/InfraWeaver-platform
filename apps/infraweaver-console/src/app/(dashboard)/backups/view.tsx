"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Archive, CheckCircle2, Clock, HardDrive, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog, RefreshButton } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";

interface LonghornBackup {
  name: string;
  createdAt: string;
  size: number;
  state: string;
  backupURL?: string;
}

interface LonghornBackupVolume {
  volumeName: string;
  backupCount: number;
  lastBackupAt: string | null;
  lastBackupName: string | null;
  size: number;
  backups?: LonghornBackup[];
}

/** Last-backup age beyond this (hours) marks a volume stale. */
const STALE_HOURS = 36;
const RESTORE_CONFIRM_WORD = "restore";

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function ageHours(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

function timeAgo(iso: string | null) {
  const h = ageHours(iso);
  if (h === null) return "Never";
  if (h < 1) return "< 1 hour ago";
  if (h < 24) return `${Math.floor(h)}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StalenessBadge({ lastBackupAt }: { lastBackupAt: string | null }) {
  const h = ageHours(lastBackupAt);
  if (h === null) {
    return <span className="inline-flex items-center gap-1 rounded-full bg-slate-500/10 px-2 py-0.5 text-xs text-slate-500 dark:text-slate-400">No backups</span>;
  }
  const stale = h >= STALE_HOURS;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
        stale ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-green-500/10 text-green-600 dark:text-green-400",
      )}
      title={stale ? `Last backup older than the ${STALE_HOURS}h freshness target` : `Backed up within the last ${STALE_HOURS}h`}
    >
      {stale ? <Clock className="h-3 w-3" aria-hidden="true" /> : <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
      {stale ? "Stale" : "Fresh"}
    </span>
  );
}

function BackupRow({ backup, onRestore }: {
  backup: LonghornBackup;
  onRestore: (url: string) => void;
}) {
  const isReady = backup.state === "Completed";
  return (
    <tr className="border-t border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3 text-xs text-slate-700 dark:text-slate-300 font-mono">{backup.name}</td>
      <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{new Date(backup.createdAt).toLocaleString()}</td>
      <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{formatBytes(backup.size)}</td>
      <td className="px-4 py-3">
        <span className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
          isReady ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
        )}>
          {isReady ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {backup.state}
        </span>
      </td>
      <td className="px-4 py-3">
        {isReady && backup.backupURL && (
          <button
            type="button"
            onClick={() => onRestore(backup.backupURL!)}
            className="flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-600/10 px-2.5 py-1 text-xs text-indigo-600 dark:text-indigo-400 hover:bg-indigo-600/20 transition-colors"
          >
            <RotateCcw className="h-3 w-3" />
            Restore
          </button>
        )}
      </td>
    </tr>
  );
}

function VolumeCard({ volume }: { volume: LonghornBackupVolume }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  const { data: backupsData, isLoading: backupsLoading } = useApiQuery<LonghornBackup[]>({
    queryKey: ["longhorn", "backups", volume.volumeName],
    path: `/api/longhorn/backups/${encodeURIComponent(volume.volumeName)}`,
    enabled: expanded,
  });
  const backupsList = backupsData ?? [];

  const restoreMut = useApiMutation<{ ok?: boolean; message?: string }, { volumeName: string; backupURL: string }>({
    path: "/api/longhorn/restore",
    successMessage: "Restore triggered — a new volume is being created",
    invalidateQueryKeys: [["longhorn", "backups"]],
    onSuccess: () => setConfirmRestore(null),
  });

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/8 bg-slate-100 dark:bg-black/20">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/[0.03]"
      >
        <div className="flex items-center gap-3">
          <HardDrive className="h-4 w-4 flex-shrink-0 text-slate-500 dark:text-slate-400" />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-white">{volume.volumeName}</div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {volume.backupCount} backup{volume.backupCount !== 1 ? "s" : ""} · Last: {timeAgo(volume.lastBackupAt)} · {formatBytes(volume.size)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StalenessBadge lastBackupAt={volume.lastBackupAt} />
          <RefreshCw className={cn("h-4 w-4 text-slate-400 dark:text-slate-500 transition-transform", expanded && "rotate-180")} />
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto border-t border-gray-200 dark:border-white/5">
          {backupsLoading ? (
            <div className="flex items-center gap-2 px-5 py-4 text-sm text-slate-500 dark:text-slate-400">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading backups…
            </div>
          ) : backupsList.length === 0 ? (
            <div className="px-5 py-4 text-sm text-slate-500">No backups available yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-white/5">
                  {["Name", "Created", "Size", "State", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {backupsList.map((b) => (
                  <BackupRow key={b.name} backup={b} onRestore={(url) => setConfirmRestore(url)} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRestore !== null}
        onConfirm={() => { if (confirmRestore) restoreMut.mutate({ volumeName: volume.volumeName, backupURL: confirmRestore }); }}
        onCancel={() => { setConfirmRestore(null); restoreMut.reset(); }}
        title={`Restore ${volume.volumeName}?`}
        description={`This creates a new Longhorn volume named "${volume.volumeName}-restored" from the selected backup. The original volume is not touched or deleted.`}
        confirmText={restoreMut.isPending ? "Restoring…" : "Restore volume"}
        danger
        requireTyping={RESTORE_CONFIRM_WORD}
      />
    </div>
  );
}

export function BackupsView() {
  const { data, isLoading, isFetching, error, refetch } = useApiQuery<LonghornBackupVolume[]>({
    queryKey: ["longhorn", "backups"],
    path: "/api/longhorn/backups",
    refetchInterval: 60_000,
  });

  const volumes = data ?? [];
  const totalBackups = volumes.reduce((s, v) => s + v.backupCount, 0);
  const freshVolumes = volumes.filter((v) => {
    const h = ageHours(v.lastBackupAt);
    return h !== null && h < STALE_HOURS;
  }).length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={Archive}
        title="Backups"
        actions={<RefreshButton onClick={() => void refetch()} refreshing={isFetching} />}
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "Volumes with Backups", value: String(volumes.length), icon: HardDrive, color: "text-gray-900 dark:text-white" },
          { label: "Total Backups", value: String(totalBackups), icon: Archive, color: "text-indigo-500 dark:text-indigo-400" },
          { label: `Fresh (< ${STALE_HOURS} h)`, value: `${freshVolumes}/${volumes.length}`, icon: CheckCircle2, color: freshVolumes === volumes.length && volumes.length > 0 ? "text-green-600 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400" },
        ].map((s) => (
          <div key={s.label} className="flex items-center gap-4 rounded-xl border border-gray-200 dark:border-white/8 bg-slate-100 dark:bg-slate-900/60 p-4">
            <s.icon className={cn("h-8 w-8 flex-shrink-0 opacity-70", s.color)} />
            <div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{s.label}</p>
              <p className={cn("mt-0.5 text-2xl font-bold", s.color)}>{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <XCircle className="h-4 w-4 flex-shrink-0 text-red-500 dark:text-red-400" />
          <p className="text-sm text-red-500 dark:text-red-400">{(error as Error).message}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      )}

      {/* Volume list */}
      {!isLoading && !error && (
        <div className="space-y-3">
          {volumes.length === 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-white/8 bg-slate-100 dark:bg-black/20 p-8 text-center text-sm text-slate-500">
              No Longhorn backup volumes found. Make sure the TrueNAS NFS backup target is configured and the first backup job has run.
            </div>
          ) : (
            volumes.map((v) => <VolumeCard key={v.volumeName} volume={v} />)
          )}
        </div>
      )}
    </motion.div>
  );
}
