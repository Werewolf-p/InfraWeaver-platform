"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, Gamepad2, Play, Square, RotateCcw, Trash2, Terminal, Loader2, AlertTriangle } from "lucide-react";
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

export default function GameHubPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});

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

  // suppress unused router warning — may be used in future navigation
  void router;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Game Hub"
        subtitle="Deploy and manage game servers on Kubernetes"
        icon={Gamepad2}
        actions={
          <Link
            href="/game-hub/new"
            className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#006cbe] text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Server
          </Link>
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

              <div className="flex items-center gap-2 flex-wrap">
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
