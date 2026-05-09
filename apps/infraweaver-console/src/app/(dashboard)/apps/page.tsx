"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import Link from "next/link";
import { useArgoApps, useSyncApp, type ArgoApp } from "@/hooks/use-argocd";
import { useRBAC } from "@/hooks/use-rbac";
import { useSettingsContext } from "@/contexts/settings-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, X, RotateCcw, Clock, GitCommit, Trash2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

function useDeleteApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/argocd/apps/${name}/delete`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["argocd", "apps"] }),
  });
}

function HealthDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    Healthy: "bg-green-500",
    Degraded: "bg-red-500",
    Progressing: "bg-yellow-500",
    Suspended: "bg-blue-500",
    Missing: "bg-slate-500",
    Unknown: "bg-slate-600",
  };
  return (
    <span className="relative flex h-2.5 w-2.5">
      {status === "Progressing" && (
        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors[status] ?? "bg-slate-500"} opacity-75`} />
      )}
      <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${colors[status] ?? "bg-slate-500"}`} />
    </span>
  );
}

function AppCard({ app, onClick, compact }: { app: ArgoApp; onClick: () => void; compact?: boolean }) {
  const borderColor = {
    Healthy: "border-green-500/20 hover:border-green-500/40",
    Degraded: "border-red-500/30 hover:border-red-500/50",
    Progressing: "border-yellow-500/20 hover:border-yellow-500/40",
    Suspended: "border-blue-500/20",
    Missing: "border-slate-500/20",
    Unknown: "border-slate-500/10",
  }[app.status.health.status] ?? "border-white/10";

  return (
    <motion.div
      whileHover={{ scale: 1.01, y: -1 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={cn(
        "bg-white/5 backdrop-blur-sm border rounded-xl cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(99,102,241,0.15)]",
        compact ? "p-3" : "p-4",
        borderColor
      )}
    >
      <div className="flex items-start justify-between mb-3">
        <h3 className="font-medium text-white text-sm truncate pr-2">{app.metadata.name}</h3>
        <HealthDot status={app.status.health.status} />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Health</span>
          <span className={cn("text-xs font-medium", {
            "text-green-400": app.status.health.status === "Healthy",
            "text-red-400": app.status.health.status === "Degraded",
            "text-yellow-400": app.status.health.status === "Progressing",
            "text-slate-400": ["Suspended","Missing","Unknown"].includes(app.status.health.status),
          })}>
            {app.status.health.status}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Sync</span>
          <span className={cn("text-xs font-medium", {
            "text-blue-400": app.status.sync.status === "Synced",
            "text-orange-400": app.status.sync.status === "OutOfSync",
            "text-slate-400": app.status.sync.status === "Unknown",
          })}>
            {app.status.sync.status}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Namespace</span>
          <span className="text-xs text-slate-400 truncate max-w-[120px]">{app.spec.destination.namespace}</span>
        </div>
      </div>
    </motion.div>
  );
}

function AppSlideOver({ app, onClose }: { app: ArgoApp; onClose: () => void }) {
  const { can, isAdmin } = useRBAC();
  const syncMutation = useSyncApp();
  const deleteMutation = useDeleteApp();
  const [showDelete, setShowDelete] = useState(false);

  const handleSync = async (hard = false) => {
    try {
      await syncMutation.mutateAsync({ name: app.metadata.name, hard });
      toast.success(`${hard ? "Hard sync" : "Sync"} triggered for ${app.metadata.name}`);
    } catch {
      toast.error("Sync failed");
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(app.metadata.name);
      toast.success(`Deleted ${app.metadata.name}`);
      setShowDelete(false);
      onClose();
    } catch {
      toast.error("Failed to delete application");
    }
  };

  const revision = app.status.operationState?.syncResult?.revision ?? app.status.sync.revision;
  const finishedAt = app.status.operationState?.finishedAt;
  const conditions = app.status.conditions ?? [];
  const errorMessage = app.status.operationState?.message;

  return (
    <>
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 30, stiffness: 300 }}
        className="fixed right-0 top-0 h-full w-full md:w-96 bg-slate-900 border-l border-white/10 z-50 overflow-y-auto shadow-2xl"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="font-semibold text-white">{app.metadata.name}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-white/5 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Health</span>
              <div className="flex items-center gap-2">
                <HealthDot status={app.status.health.status} />
                <span className="text-sm text-white">{app.status.health.status}</span>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Sync Status</span>
              <span className="text-sm text-white">{app.status.sync.status}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Project</span>
              <span className="text-sm text-white">{app.spec.project}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">Namespace</span>
              <span className="text-sm text-white">{app.spec.destination.namespace}</span>
            </div>
            {finishedAt && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 flex items-center gap-1"><Clock className="w-3 h-3" /> Last Sync</span>
                <span className="text-xs text-slate-300">{timeAgo(finishedAt)}</span>
              </div>
            )}
            {revision && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-400 flex items-center gap-1"><GitCommit className="w-3 h-3" /> Revision</span>
                <span className="text-xs text-slate-300 font-mono">{revision.slice(0, 7)}</span>
              </div>
            )}
          </div>

          {errorMessage && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <p className="text-xs font-semibold text-red-400 mb-1">Last Operation Message</p>
              <p className="text-xs text-red-300">{errorMessage}</p>
            </div>
          )}

          {conditions.length > 0 && (
            <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
              <p className="text-xs font-semibold text-yellow-400 mb-2">Conditions</p>
              <div className="space-y-1">
                {conditions.map((c, i) => (
                  <div key={i} className="text-xs text-yellow-300">
                    <span className="font-medium">{c.type}:</span> {c.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(can("apps:sync") || isAdmin) && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Actions</h3>
              <div className="flex gap-2">
                {can("apps:sync") && (
                  <>
                    <button
                      onClick={() => handleSync(false)}
                      disabled={syncMutation.isPending}
                      className="flex-1 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-sm font-medium hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
                    >
                      Sync
                    </button>
                    <button
                      onClick={() => handleSync(true)}
                      disabled={syncMutation.isPending}
                      className="flex-1 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors disabled:opacity-50"
                    >
                      Hard Sync
                    </button>
                  </>
                )}
                <div className="relative group">
                  <button
                    disabled={!isAdmin}
                    className="flex items-center gap-1 py-2 px-3 rounded-lg bg-white/5 border border-white/10 text-slate-400 text-sm font-medium cursor-not-allowed opacity-50"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Rollback
                  </button>
                  {!isAdmin && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded text-xs bg-slate-800 text-slate-300 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                      Admin only
                    </div>
                  )}
                </div>
              </div>

              {/* View Logs button */}
              <Link
                href={`/logs?namespace=${encodeURIComponent(app.spec.destination.namespace)}`}
                className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                View Pod Logs
              </Link>

              {/* Delete button */}
              {isAdmin && (
                <button
                  onClick={() => setShowDelete(true)}
                  className="w-full py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 transition-colors flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Application
                </button>
              )}
            </div>
          )}

          {app.status.summary?.images && app.status.summary.images.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Images</h3>
              <div className="space-y-1">
                {app.status.summary.images.map(img => (
                  <div key={img} className="text-xs text-slate-300 bg-white/5 rounded px-3 py-2 font-mono truncate">{img}</div>
                ))}
              </div>
            </div>
          )}

          {app.status.summary?.externalURLs && app.status.summary.externalURLs.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">External URLs</h3>
              <div className="space-y-1">
                {app.status.summary.externalURLs.map(url => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-400 hover:text-indigo-300 bg-white/5 rounded px-3 py-2 block truncate">{url}</a>
                ))}
              </div>
            </div>
          )}
        </div>
      </motion.div>

      <ConfirmDialog
        open={showDelete}
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
        title={`Delete ${app.metadata.name}?`}
        description="This will permanently delete the ArgoCD application. The Kubernetes resources may also be removed depending on cascade settings."
        confirmText="Delete Application"
        danger
      />
    </>
  );
}

export default function AppsPage() {
  const { data: apps, isLoading, refetch } = useArgoApps();
  const { settings } = useSettingsContext();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [selectedApp, setSelectedApp] = useState<ArgoApp | null>(null);

  const SYSTEM_PREFIXES = ["core-", "bootstrap", "platform-"];
  const isSystemApp = (name: string) => SYSTEM_PREFIXES.some(p => name.startsWith(p));

  const filtered = (apps ?? []).filter(app => {
    if (!settings.showSystemApps && isSystemApp(app.metadata.name)) return false;
    const matchesSearch = app.metadata.name.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all"
      || (filter === "outofsync" ? app.status.sync.status === "OutOfSync" : app.status.health.status.toLowerCase() === filter);
    return matchesSearch && matchesFilter;
  });

  const visibleApps = settings.showSystemApps ? (apps ?? []) : (apps ?? []).filter(a => !isSystemApp(a.metadata.name));
  const counts = {
    all: visibleApps.length,
    healthy: visibleApps.filter(a => a.status.health.status === "Healthy").length,
    degraded: visibleApps.filter(a => a.status.health.status === "Degraded").length,
    progressing: visibleApps.filter(a => a.status.health.status === "Progressing").length,
    outofsync: visibleApps.filter(a => a.status.sync.status === "OutOfSync").length,
  };

  const degradedCount = (apps ?? []).filter(a => a.status.health.status === "Degraded").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            Applications
            {degradedCount > 0 && (
              <span className="relative flex h-5 w-5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-5 w-5 bg-red-500 items-center justify-center text-[10px] font-bold text-white">
                  {degradedCount}
                </span>
              </span>
            )}
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">ArgoCD managed applications</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search apps..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        {(["all", "healthy", "degraded", "progressing", "outofsync"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-2 rounded-lg text-xs font-medium capitalize transition-colors",
              filter === f
                ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300"
                : "bg-white/5 border border-white/10 text-slate-400 hover:text-white"
            )}
          >
            {f === "outofsync" ? "Out of Sync" : f} ({counts[f]})
          </button>
        ))}
        {!settings.showSystemApps && (
          <span className="text-xs text-slate-500 px-2 py-1 bg-white/5 rounded-lg border border-white/5">
            System apps hidden
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="h-36 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : (
        <motion.div
          layout
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
        >
          <AnimatePresence mode="popLayout">
            {filtered.map(app => (
              <motion.div
                key={app.metadata.name}
                layout
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
              >
                <AppCard app={app} onClick={() => setSelectedApp(app)} compact={settings.compactMode} />
              </motion.div>
            ))}
            {filtered.length === 0 && !isLoading && (
              <div className="col-span-full flex flex-col items-center justify-center py-20 text-center">
                <svg className="w-16 h-16 text-slate-700 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                <p className="text-slate-400 font-medium">No applications found</p>
                <p className="text-slate-600 text-sm mt-1">Try adjusting your search or filter</p>
              </div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      <AnimatePresence>
        {selectedApp && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedApp(null)}
              className="fixed inset-0 bg-black/50 z-40"
            />
            <AppSlideOver app={selectedApp} onClose={() => setSelectedApp(null)} />
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
