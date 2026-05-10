"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { useArgoApps, useSyncApp, type ArgoApp } from "@/hooks/use-argocd";
import { useRBAC } from "@/hooks/use-rbac";
import { useSettingsContext } from "@/contexts/settings-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, X, RotateCcw, Clock, GitCommit, Trash2, ExternalLink, Play, ChevronDown, Zap } from "lucide-react";
import { toast } from "sonner";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeploymentFrequencyChart } from "@/components/charts/deployment-frequency";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confettiLib: any = null;
async function fireConfetti() {
  if (!confettiLib) {
    confettiLib = await import("canvas-confetti");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fire: (opts: object) => void = confettiLib.default ?? confettiLib;
  fire({
    particleCount: 40,
    spread: 55,
    origin: { y: 0.6 },
    colors: ["#6366f1", "#8b5cf6", "#06b6d4", "#22c55e"],
    disableForReducedMotion: true,
  });
}

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

function getDisplayHealth(app: ArgoApp): string {
  if (app.status.health.status === "Progressing" && app.status.sync.status === "Synced") return "Syncing";
  return app.status.health.status;
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
  const [showPreview, setShowPreview] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const previewTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const borderColor = {
    Healthy: "border-green-500/20 hover:border-green-500/40",
    Degraded: "border-red-500/30 hover:border-red-500/50",
    Progressing: "border-yellow-500/20 hover:border-yellow-500/40",
    Suspended: "border-blue-500/20",
    Missing: "border-slate-500/20",
    Unknown: "border-slate-500/10",
  }[app.status.health.status] ?? "border-white/10";

  const handleMouseEnter = () => {
    previewTimeout.current = setTimeout(() => setShowPreview(true), 200);
  };
  const handleMouseLeave = () => {
    if (previewTimeout.current) clearTimeout(previewTimeout.current);
    setShowPreview(false);
  };

  const handleRestart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setRestarting(true);
    try {
      const res = await fetch("/api/cluster/restart-app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: app.spec.destination.namespace, appName: app.metadata.name }),
      });
      if (!res.ok) throw new Error("Restart failed");
      toast.success(`Restarted ${app.metadata.name}`);
    } catch {
      toast.error(`Failed to restart ${app.metadata.name}`);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="relative" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <motion.div
        whileHover={{ scale: 1.01, y: -1 }}
        whileTap={{ scale: 0.97 }}
        onClick={onClick}
        className={cn(
          "bg-white/5 backdrop-blur-sm border rounded-xl cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(99,102,241,0.15)] touch-manipulation",
          compact ? "p-3" : "p-3 md:p-4",
          borderColor
        )}
      >
        <div className="flex items-start justify-between mb-3">
          <h3 className="font-medium text-white text-sm truncate pr-2">{app.metadata.name}</h3>
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleRestart}
              disabled={restarting}
              title="Rolling restart"
              className="opacity-0 group-hover:opacity-100 hover:opacity-100 flex items-center justify-center w-6 h-6 rounded-md hover:bg-white/10 text-white/40 hover:text-white transition-all disabled:opacity-30"
            >
              {restarting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            </button>
            <HealthDot status={app.status.health.status} />
          </div>
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
              {getDisplayHealth(app)}
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

      {/* Hover preview card */}
      <AnimatePresence>
        {showPreview && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 4 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 mb-2 w-56 bg-slate-900/95 border border-white/10 rounded-xl shadow-2xl p-3 z-20 pointer-events-none"
          >
            <p className="text-xs font-semibold text-white mb-2 truncate">{app.metadata.name}</p>
            <div className="space-y-1.5 text-xs text-slate-400">
              <div className="flex justify-between">
                <span>Namespace</span>
                <span className="text-slate-300">{app.spec.destination.namespace}</span>
              </div>
              <div className="flex justify-between">
                <span>Repo</span>
                <span className="text-slate-300 truncate ml-2 max-w-[100px]">
                  {app.spec.source?.repoURL?.split("/").slice(-1)[0] ?? "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Target</span>
                <span className="text-slate-300">{app.spec.source?.targetRevision ?? "HEAD"}</span>
              </div>
              <div className="flex justify-between">
                <span>Last sync</span>
                <span className="text-slate-300">
                  {app.status.operationState?.finishedAt
                    ? timeAgo(app.status.operationState.finishedAt)
                    : "—"}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
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
      fireConfetti();
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
                <span className="text-sm text-white">{getDisplayHealth(app)}</span>
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

              {/* Open in ArgoCD button */}
              <a
                href={`${process.env.NEXT_PUBLIC_ARGOCD_URL || 'https://argocd.int.rlservers.com'}/applications/${app.metadata.name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in ArgoCD
              </a>

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
  const [showAllApps, setShowAllApps] = useState(false);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullY, setPullY] = useState(0);
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());
  const [showTimeline, setShowTimeline] = useState(false);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const APPS_PAGE_SIZE = 8;

  const { data: argoEvents } = useQuery({
    queryKey: ["argocd", "events"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/events");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ events: { appName: string; phase: string; startedAt: string }[] }>;
    },
    staleTime: 60000,
  });

  const handlePullRefresh = useCallback(async () => {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    await refetch();
    setPullRefreshing(false);
    setPullY(0);
  }, [pullRefreshing, refetch]);

  const SYSTEM_PREFIXES = ["core-", "bootstrap", "platform-"];
  const isSystemApp = (name: string) => SYSTEM_PREFIXES.some(p => name.startsWith(p));

  const filtered = (apps ?? []).filter(app => {
    if (!settings.showSystemApps && isSystemApp(app.metadata.name)) return false;
    const matchesSearch = app.metadata.name.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all"
      || (filter === "outofsync" ? app.status.sync.status === "OutOfSync" : app.status.health.status.toLowerCase() === filter);
    return matchesSearch && matchesFilter;
  });

  // Reset show-all when filter or search changes
  useEffect(() => {
    setShowAllApps(false);
  }, [search, filter]);

  const handleBulkSync = async () => {
    setBulkSyncing(true);
    try {
      await Promise.all(Array.from(selectedApps).map(name =>
        fetch(`/api/argocd/apps/${name}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
      ));
      toast.success(`Synced ${selectedApps.size} app${selectedApps.size !== 1 ? "s" : ""}`);
      fireConfetti();
      setSelectedApps(new Set());
    } catch {
      toast.error("Bulk sync failed");
    } finally {
      setBulkSyncing(false);
    }
  };

  const toggleAppSelect = (name: string) => {
    setSelectedApps(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const displayedApps = showAllApps || filtered.length <= APPS_PAGE_SIZE ? filtered : filtered.slice(0, APPS_PAGE_SIZE);
  const hiddenCount = filtered.length - APPS_PAGE_SIZE;

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
      {/* Pull-to-refresh indicator */}
      <motion.div
        drag="y"
        dragConstraints={{ top: 0, bottom: 80 }}
        dragElastic={0.3}
        onDrag={(_, info) => setPullY(Math.max(0, info.offset.y))}
        onDragEnd={(_, info) => {
          if (info.offset.y > 60) handlePullRefresh();
          else setPullY(0);
        }}
        style={{ y: 0 }}
        className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
      >
        <AnimatePresence>
          {pullY > 20 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center py-2"
            >
              <RefreshCw className={cn("w-5 h-5 text-indigo-400", pullRefreshing && "animate-spin")} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-apps pointer-events-none" />
        <div className="relative flex items-center justify-between p-5">
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
        <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors active:scale-95">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
        <button onClick={() => setShowTimeline(v => !v)} className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors active:scale-95", showTimeline ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300" : "bg-white/5 border-white/10 text-slate-300 hover:text-white")}>
          <Clock className="w-3.5 h-3.5" />
          Timeline
        </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-5">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search apps..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2.5 text-base md:text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 pb-1">
          {(["all", "healthy", "degraded", "progressing", "outofsync"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-2 rounded-lg text-xs font-medium capitalize transition-colors whitespace-nowrap touch-manipulation active:scale-95 flex-shrink-0",
                filter === f
                  ? "bg-indigo-500/20 border border-indigo-500/30 text-indigo-300"
                  : "bg-white/5 border border-white/10 text-slate-400 hover:text-white"
              )}
            >
              {f === "outofsync" ? "Out of Sync" : f} ({counts[f]})
            </button>
          ))}
          {!settings.showSystemApps && (
            <span className="text-xs text-slate-500 px-2 py-1 bg-white/5 rounded-lg border border-white/5 whitespace-nowrap flex-shrink-0">
              System apps hidden
            </span>
          )}
        </div>
      </div>

      {showTimeline && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mb-4 bg-white/5 border border-white/10 rounded-xl p-4 overflow-hidden">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Last Sync Timeline</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(apps ?? [])
              .filter(a => a.status.operationState?.finishedAt)
              .sort((a, b) => new Date(b.status.operationState!.finishedAt!).getTime() - new Date(a.status.operationState!.finishedAt!).getTime())
              .map(a => (
                <div key={a.metadata.name} className="flex items-center gap-3 text-xs">
                  <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", a.status.health.status === "Healthy" ? "bg-green-400" : "bg-red-400")} />
                  <span className="text-white font-medium truncate flex-1">{a.metadata.name}</span>
                  <span className="text-slate-500 flex-shrink-0">{timeAgo(a.status.operationState!.finishedAt!)}</span>
                </div>
              ))}
          </div>
        </motion.div>
      )}

      {selectedApps.size > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mb-4 flex items-center gap-3 p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
          <span className="text-sm text-indigo-300">{selectedApps.size} app{selectedApps.size !== 1 ? "s" : ""} selected</span>
          <button
            onClick={handleBulkSync}
            disabled={bulkSyncing}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/30 border border-indigo-500/40 text-xs text-indigo-200 hover:bg-indigo-500/40 transition-colors disabled:opacity-50"
          >
            {bulkSyncing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
            Sync Selected ({selectedApps.size})
          </button>
          <button onClick={() => setSelectedApps(new Set())} className="ml-auto text-xs text-slate-500 hover:text-white transition-colors">Clear</button>
        </motion.div>
      )}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(12)].map((_, i) => (
            <div key={i} className="h-36 rounded-xl bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          {argoEvents && (
            <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 mb-4">
              <h3 className="text-sm font-semibold text-white mb-3">Deployment Frequency (Last 30 Days)</h3>
              <DeploymentFrequencyChart events={argoEvents.events ?? []} />
            </div>
          )}
          <motion.div
            layout
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
          >
            <AnimatePresence mode="popLayout">
              {displayedApps.map(app => (
                <motion.div
                  key={app.metadata.name}
                  layout
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="relative"
                >
                  <button
                    onClick={e => { e.stopPropagation(); toggleAppSelect(app.metadata.name); }}
                    className={cn(
                      "absolute top-2 left-2 z-10 w-4 h-4 rounded border flex items-center justify-center transition-all",
                      selectedApps.has(app.metadata.name)
                        ? "bg-indigo-500 border-indigo-400"
                        : "bg-white/10 border-white/20 hover:border-indigo-400"
                    )}
                  >
                    {selectedApps.has(app.metadata.name) && (
                      <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
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

          {filtered.length > APPS_PAGE_SIZE && (
            <motion.button
              layout
              onClick={() => setShowAllApps(v => !v)}
              className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-400 hover:text-white hover:bg-white/8 transition-colors"
            >
              <ChevronDown className={cn("w-4 h-4 transition-transform", showAllApps && "rotate-180")} />
              {showAllApps
                ? "Show fewer apps"
                : `Show all ${filtered.length} apps (${hiddenCount} more)`}
            </motion.button>
          )}
        </>
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
