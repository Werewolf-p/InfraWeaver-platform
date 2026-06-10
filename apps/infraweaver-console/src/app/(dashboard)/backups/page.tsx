"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, CheckCircle2, Clock, HardDrive, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

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

async function fetchBackups(): Promise<LonghornBackupVolume[]> {
  const res = await fetch("/api/longhorn/backups");
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? "Failed to load backups");
  }
  return res.json() as Promise<LonghornBackupVolume[]>;
}

async function triggerRestore(body: { volumeName: string; backupURL: string; targetVolumeName?: string }) {
  const res = await fetch("/api/longhorn/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as { ok?: boolean; message?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? "Restore failed");
  return data;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function timeAgo(iso: string | null) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1 hour ago";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function BackupRow({ backup, onRestore }: {
  backup: LonghornBackup;
  onRestore: (url: string) => void;
}) {
  const isReady = backup.state === "Completed";
  return (
    <tr className="border-t border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3 text-xs text-slate-300 font-mono">{backup.name}</td>
      <td className="px-4 py-3 text-xs text-slate-400">{new Date(backup.createdAt).toLocaleString()}</td>
      <td className="px-4 py-3 text-xs text-slate-400">{formatBytes(backup.size)}</td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
          isReady ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"
        }`}>
          {isReady ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {backup.state}
        </span>
      </td>
      <td className="px-4 py-3">
        {isReady && backup.backupURL && (
          <button
            type="button"
            onClick={() => onRestore(backup.backupURL!)}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600/20 border border-indigo-500/30 px-2.5 py-1 text-xs text-indigo-400 hover:bg-indigo-600/30 transition-colors"
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
  const queryClient = useQueryClient();
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState("");

  const { data: backupsData, isLoading: backupsLoading } = useQuery({
    queryKey: ["longhorn", "backups", volume.volumeName],
    queryFn: async () => {
      const res = await fetch(`/api/longhorn/backups/${encodeURIComponent(volume.volumeName)}`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json() as Promise<LonghornBackup[]>;
    },
    enabled: expanded,
  });
  const backupsList = backupsData ?? [];

  const restoreMut = useMutation({
    mutationFn: (args: { backupURL: string }) =>
      triggerRestore({ volumeName: volume.volumeName, backupURL: args.backupURL, targetVolumeName: restoreTarget || undefined }),
    onSuccess: () => {
      setConfirmRestore(null);
      setRestoreTarget("");
      void queryClient.invalidateQueries({ queryKey: ["longhorn", "backups"] });
    },
  });

  return (
    <div className="rounded-xl border border-white/8 bg-black/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 hover:bg-white/[0.03] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <HardDrive className="h-4 w-4 text-slate-400 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-white">{volume.volumeName}</div>
            <div className="text-xs text-slate-400 mt-0.5">
              {volume.backupCount} backup{volume.backupCount !== 1 ? "s" : ""} · Last: {timeAgo(volume.lastBackupAt)} · {formatBytes(volume.size)}
            </div>
          </div>
        </div>
        <RefreshCw className={`h-4 w-4 text-slate-500 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t border-white/5 overflow-x-auto">
          {backupsLoading ? (
            <div className="px-5 py-4 text-sm text-slate-400 flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />Loading backups…
            </div>
          ) : backupsList.length === 0 ? (
            <div className="px-5 py-4 text-sm text-slate-500">No backups available yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  {["Name", "Created", "Size", "State", ""].map((h) => (
                    <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {backupsList.map((b) => (
                  <BackupRow
                    key={b.name}
                    backup={b}
                    onRestore={(url) => { setConfirmRestore(url); setRestoreTarget(""); }}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Restore confirmation modal */}
      {confirmRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0d1117] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-white font-semibold">
              <RotateCcw className="h-5 w-5 text-indigo-400" />
              Confirm Restore
            </div>
            <p className="text-sm text-slate-300">
              This will create a new Longhorn volume restored from the selected backup. The original volume is not
              deleted.
            </p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Target volume name (leave blank to use <code className="text-xs bg-white/5 px-1 rounded">{volume.volumeName}-restored</code>)
              </label>
              <input
                type="text"
                value={restoreTarget}
                onChange={(e) => setRestoreTarget(e.target.value)}
                placeholder={`${volume.volumeName}-restored`}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            {restoreMut.error && (
              <p className="text-xs text-red-400">{(restoreMut.error as Error).message}</p>
            )}
            {restoreMut.isSuccess && (
              <p className="text-xs text-green-400 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Restore triggered successfully.
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => { setConfirmRestore(null); restoreMut.reset(); }}
                className="px-4 py-2 rounded-lg border border-white/10 text-sm text-slate-300 hover:bg-white/5 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoreMut.isPending}
                onClick={() => restoreMut.mutate({ backupURL: confirmRestore })}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm text-white font-medium transition-colors disabled:opacity-50"
              >
                {restoreMut.isPending && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                Restore
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function BackupsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["longhorn", "backups"],
    queryFn: fetchBackups,
    refetchInterval: 60_000,
  });

  const volumes = data ?? [];
  const totalBackups = volumes.reduce((s, v) => s + v.backupCount, 0);
  const freshVolumes = volumes.filter((v) => {
    if (!v.lastBackupAt) return false;
    return Date.now() - new Date(v.lastBackupAt).getTime() < 36 * 3_600_000;
  }).length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader icon={Archive} title="Backups" />
        <button
          type="button"
          onClick={() => void refetch()}
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 hover:bg-white/8 transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          { label: "Volumes with Backups", value: String(volumes.length), icon: HardDrive, color: "text-white" },
          { label: "Total Backups", value: String(totalBackups), icon: Archive, color: "text-indigo-400" },
          { label: "Fresh (< 36 h)", value: `${freshVolumes}/${volumes.length}`, icon: CheckCircle2, color: freshVolumes === volumes.length && volumes.length > 0 ? "text-green-400" : "text-yellow-400" },
        ].map((s) => (
          <div key={s.label} className="bg-slate-900/60 border border-white/8 rounded-xl p-4 flex items-center gap-4">
            <s.icon className={`h-8 w-8 ${s.color} flex-shrink-0 opacity-70`} />
            <div>
              <p className="text-xs text-slate-400">{s.label}</p>
              <p className={`text-2xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{(error as Error).message}</p>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      )}

      {/* Volume list */}
      {!isLoading && !error && (
        <div className="space-y-3">
          {volumes.length === 0 ? (
            <div className="rounded-xl border border-white/8 bg-black/20 p-8 text-center text-sm text-slate-500">
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
