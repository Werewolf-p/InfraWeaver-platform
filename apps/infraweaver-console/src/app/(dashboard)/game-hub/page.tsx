"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Gamepad2, Play, Square, RotateCcw, Trash2, Terminal, Loader2, AlertTriangle, HardDrive, X, CheckSquare, Square as SquareIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import Link from "next/link";

interface GameServer {
  name: string;
  gameType: string;
  status: string;
  replicas: number;
  readyReplicas: number;
  podName: string | null;
  port: number;
  nodePort: number;
  memory: string;
  cpu: string;
  createdAt: string | null;
}

interface UnusedPVC {
  namespace: string;
  name: string;
  status: string;
  storageClass: string;
  capacity: string;
  createdAt: string | null;
}

const GAME_ICONS: Record<string, string> = {
  minecraft: "⛏",
  terraria: "🌍",
  valheim: "🪓",
};

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500/20 text-green-300 border-green-500/30",
  starting: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  stopped: "bg-[#333] text-[#999] border-[#444]",
  crashed: "bg-red-500/20 text-red-300 border-red-500/30",
};

function PVCCleanupModal({ onClose }: { onClose: () => void }) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["pvc-cleanup"],
    queryFn: async () => {
      const res = await fetch("/api/storage/pvc-cleanup");
      if (!res.ok) throw new Error("Failed to fetch unused PVCs");
      const d = await res.json() as { unused: UnusedPVC[] };
      // auto-check all on first load
      setChecked(new Set(d.unused.map(p => `${p.namespace}/${p.name}`)));
      return d;
    },
    staleTime: 0,
  });

  const unused = data?.unused ?? [];

  function toggleAll() {
    if (checked.size === unused.length) setChecked(new Set());
    else setChecked(new Set(unused.map(p => `${p.namespace}/${p.name}`)));
  }

  function toggle(key: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function doCleanup() {
    const toDelete = unused.filter(p => checked.has(`${p.namespace}/${p.name}`));
    if (toDelete.length === 0) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/storage/pvc-cleanup", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pvcs: toDelete.map(p => ({ namespace: p.namespace, name: p.name })) }),
      });
      const result = await res.json() as { deleted: number; failed: number };
      if (result.failed > 0) toast.error(`${result.failed} PVC(s) failed to delete`);
      else toast.success(`${result.deleted} PVC(s) deleted`);
      onClose();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.96 }}
        className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#2a2a2a]">
          <div className="flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-[#0078D4]" />
            <div>
              <h2 className="text-sm font-semibold text-[#f2f2f2]">PVC Cleanup</h2>
              <p className="text-xs text-[#666] mt-0.5">Remove unused PersistentVolumeClaims</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#252525] text-[#666] hover:text-[#f2f2f2] transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading && (
            <div className="flex items-center justify-center h-32 gap-2 text-[#666]">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Scanning PVCs...</span>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {String(error)}
            </div>
          )}
          {!isLoading && !error && unused.length === 0 && (
            <div className="flex flex-col items-center justify-center h-32 text-center gap-2">
              <div className="text-3xl">✅</div>
              <p className="text-sm text-[#f2f2f2] font-medium">No unused PVCs found</p>
              <p className="text-xs text-[#666]">All PersistentVolumeClaims are bound and in use</p>
            </div>
          )}
          {!isLoading && unused.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-[#666]">{unused.length} unused PVC{unused.length !== 1 ? "s" : ""} found</p>
                <button onClick={toggleAll} className="text-xs text-[#0078D4] hover:underline flex items-center gap-1">
                  {checked.size === unused.length ? <SquareIcon className="w-3 h-3" /> : <CheckSquare className="w-3 h-3" />}
                  {checked.size === unused.length ? "Deselect all" : "Select all"}
                </button>
              </div>
              {unused.map(pvc => {
                const key = `${pvc.namespace}/${pvc.name}`;
                const isChecked = checked.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggle(key)}
                    className={cn(
                      "w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors",
                      isChecked
                        ? "bg-red-500/10 border-red-500/30 hover:bg-red-500/15"
                        : "bg-[#252525] border-[#2a2a2a] hover:bg-[#2a2a2a]"
                    )}
                  >
                    <div className={cn("mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center",
                      isChecked ? "bg-red-500 border-red-500" : "border-[#444]")}>
                      {isChecked && <span className="text-white text-[10px] font-bold">✓</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-[#f2f2f2] truncate">{pvc.name}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0",
                          pvc.status === "Released" ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/30" :
                          pvc.status === "Lost" ? "bg-red-500/20 text-red-300 border-red-500/30" :
                          "bg-[#333] text-[#999] border-[#444]")}>{pvc.status}</span>
                      </div>
                      <p className="text-[11px] text-[#666] mt-0.5">{pvc.namespace} · {pvc.storageClass || "default"} · {pvc.capacity || "unknown size"}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {!isLoading && unused.length > 0 && (
          <div className="flex items-center justify-between gap-3 p-5 border-t border-[#2a2a2a]">
            <p className="text-xs text-[#666]">{checked.size} of {unused.length} selected</p>
            <div className="flex gap-2">
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] text-sm font-medium transition-colors">
                Cancel
              </button>
              <button
                onClick={doCleanup}
                disabled={checked.size === 0 || deleting}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-300 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Delete {checked.size > 0 ? `${checked.size} PVC${checked.size !== 1 ? "s" : ""}` : ""}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}

export default function GameHubPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [showPVCCleanup, setShowPVCCleanup] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["game-hub", "servers"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ servers: GameServer[] }>;
    },
    refetchInterval: 15000,
  });

  const servers = data?.servers ?? [];

  async function doAction(name: string, action: string) {
    setActionLoading(prev => ({ ...prev, [name]: action }));
    try {
      if (action === "delete") {
        const res = await fetch(`/api/game-hub/servers/${name}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Delete failed");
        toast.success(`${name} deleted`);
      } else {
        const res = await fetch(`/api/game-hub/servers/${name}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error(`${action} failed`);
        toast.success(`${name} ${action} successful`);
      }
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[name]; return n; });
    }
  }

  void router;

  return (
    <div className="space-y-6">
      <AnimatePresence>
        {showPVCCleanup && <PVCCleanupModal onClose={() => setShowPVCCleanup(false)} />}
      </AnimatePresence>

      <PageHeader
        title="Game Hub"
        subtitle="Deploy and manage game servers on Kubernetes"
        icon={Gamepad2}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPVCCleanup(true)}
              className="flex items-center gap-2 px-3 py-2 bg-[#252525] hover:bg-[#2a2a2a] border border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2] rounded-lg text-sm font-medium transition-colors"
            >
              <HardDrive className="w-4 h-4" />
              <span className="hidden sm:inline">Cleanup PVCs</span>
            </button>
            <Link
              href="/game-hub/new"
              className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Server
            </Link>
          </div>
        }
      />

      {isLoading && (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium">Failed to load servers</p>
            <p className="text-xs text-red-400 mt-0.5">Is the game-hub namespace set up? <Link href="/game-hub/setup" className="underline">Run setup</Link></p>
          </div>
        </div>
      )}

      {!isLoading && !error && servers.length === 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center h-64 rounded-xl border border-dashed border-[#2a2a2a] gap-4"
        >
          <div className="text-5xl">🎮</div>
          <div className="text-center">
            <p className="text-[#f2f2f2] font-medium">No game servers yet</p>
            <p className="text-[#666] text-sm mt-1">Deploy your first server to get started</p>
          </div>
          <Link
            href="/game-hub/new"
            className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Deploy Server
          </Link>
        </motion.div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence>
          {servers.map((server, i) => (
            <motion.div
              key={server.name}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: i * 0.05 }}
              className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-5 flex flex-col gap-4 cursor-pointer hover:border-[#3a3a3a] transition-colors"
              onClick={() => window.location.href = `/game-hub/${server.name}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-[#252525] flex items-center justify-center text-xl">
                    {GAME_ICONS[server.gameType] ?? "🎮"}
                  </div>
                  <div>
                    <p className="font-medium text-sm text-[#f2f2f2]">{server.name}</p>
                    <p className="text-xs text-[#666] capitalize">{server.gameType}</p>
                  </div>
                </div>
                <span className={cn("text-xs font-medium rounded-full px-2 py-0.5 border capitalize", STATUS_COLORS[server.status] ?? STATUS_COLORS.stopped)}>
                  {server.status}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-[#666]">
                <div>Port: <span className="text-[#9e9e9e]">{server.nodePort || server.port || "—"}</span></div>
                <div>Memory: <span className="text-[#9e9e9e]">{server.memory || "—"}</span></div>
              </div>

              <div className="flex items-center gap-2 flex-wrap" onClick={e => e.stopPropagation()}>
                {server.status === "stopped" ? (
                  <button
                    onClick={() => doAction(server.name, "start")}
                    disabled={!!actionLoading[server.name]}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                  >
                    {actionLoading[server.name] === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    Start
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => doAction(server.name, "stop")}
                      disabled={!!actionLoading[server.name]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {actionLoading[server.name] === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                      Stop
                    </button>
                    <button
                      onClick={() => doAction(server.name, "restart")}
                      disabled={!!actionLoading[server.name]}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {actionLoading[server.name] === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                      Restart
                    </button>
                  </>
                )}
                <Link
                  href={`/game-hub/${server.name}`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[rgba(0,120,212,0.15)] hover:bg-[rgba(0,120,212,0.25)] text-[#0078D4] rounded-lg text-xs font-medium transition-colors"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Console
                </Link>
                <button
                  onClick={() => { if (confirm(`Delete ${server.name}? This will remove the server and its data.`)) doAction(server.name, "delete"); }}
                  disabled={!!actionLoading[server.name]}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {actionLoading[server.name] === "delete" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );

}
