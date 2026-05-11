"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Gamepad2, ChevronLeft, Play, Square, RotateCcw, Loader2, Terminal, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import Link from "next/link";

const GAME_ICONS: Record<string, string> = { minecraft: "⛏", terraria: "🌍", valheim: "🪓" };

interface ServerDetail {
  name: string;
  gameType: string;
  replicas: number;
  readyReplicas: number;
  podName: string | null;
  podPhase: string | null;
  podStartTime: string | null;
  port: number | null;
  nodePort: number | null;
  memory: string;
  cpu: string;
  env: Array<{ name: string; value: string }>;
  createdAt: string | null;
}

type TabId = "overview" | "console" | "settings";

export default function ServerDetailPage({ params }: { params: { name: string } }) {
  const { name } = params;
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: server, isLoading } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}`);
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<ServerDetail>;
    },
    refetchInterval: 10000,
  });

  const { data: consoleData } = useQuery({
    queryKey: ["game-hub", "console", name],
    queryFn: async () => {
      const res = await fetch(`/api/game-hub/servers/${name}/console`);
      if (!res.ok) return null;
      return res.json() as Promise<{ podName: string; namespace: string; containerName: string; logsUrl: string }>;
    },
    enabled: activeTab === "console",
  });

  async function doAction(action: string) {
    setActionLoading(action);
    try {
      const res = await fetch(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(`${action} failed`);
      toast.success(`${action} successful`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (err) {
      toast.error(String(err));
    } finally {
      setActionLoading(null);
    }
  }

  const status = server?.readyReplicas && server.readyReplicas > 0 ? "running" : server?.replicas ? "starting" : "stopped";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/game-hub" className="text-[#666] hover:text-[#9e9e9e] transition-colors">
          <ChevronLeft className="w-5 h-5" />
        </Link>
        <PageHeader
          title={name}
          subtitle={`${server?.gameType ?? "Game"} server`}
          icon={Gamepad2}
        />
      </div>

      {isLoading && <div className="flex items-center justify-center h-40"><Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" /></div>}

      {server && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
          {/* Status bar */}
          <div className="flex items-center gap-4 p-4 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a]">
            <div className="text-3xl">{GAME_ICONS[server.gameType] ?? "🎮"}</div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className={cn("w-2 h-2 rounded-full", status === "running" ? "bg-green-400 animate-pulse" : status === "starting" ? "bg-yellow-400 animate-pulse" : "bg-[#555]")} />
                <span className={cn("text-sm font-medium capitalize", status === "running" ? "text-green-400" : status === "starting" ? "text-yellow-400" : "text-[#666]")}>{status}</span>
              </div>
              <p className="text-xs text-[#666] mt-0.5">Node Port: {server.nodePort ?? "—"} | Memory: {server.memory} | CPU: {server.cpu}</p>
            </div>
            <div className="flex items-center gap-2">
              {status === "stopped" ? (
                <button onClick={() => doAction("start")} disabled={!!actionLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                  {actionLoading === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start
                </button>
              ) : (
                <>
                  <button onClick={() => doAction("stop")} disabled={!!actionLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                    {actionLoading === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />} Stop
                  </button>
                  <button onClick={() => doAction("restart")} disabled={!!actionLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#252525] hover:bg-[#2a2a2a] text-[#9e9e9e] rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
                    {actionLoading === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Restart
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[#2a2a2a]">
            {(["overview", "console", "settings"] as TabId[]).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-4 py-2.5 text-sm font-medium capitalize transition-colors border-b-2 -mb-px",
                  activeTab === tab ? "border-[#0078D4] text-[#0078D4]" : "border-transparent text-[#666] hover:text-[#9e9e9e]"
                )}
              >
                {tab}
              </button>
            ))}
          </div>

          {activeTab === "overview" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {[
                  { label: "Status", value: status },
                  { label: "Game Port", value: server.port?.toString() ?? "—" },
                  { label: "Node Port", value: server.nodePort?.toString() ?? "—" },
                  { label: "Pod Phase", value: server.podPhase ?? "—" },
                ].map(item => (
                  <div key={item.label} className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4">
                    <p className="text-xs text-[#666] mb-1">{item.label}</p>
                    <p className="text-sm font-medium text-[#f2f2f2] capitalize">{item.value}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4">
                <p className="text-xs text-[#666] mb-3 font-medium">Environment Variables</p>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {server.env.filter(e => !e.name.includes("SECRET") && !e.name.includes("PASS") && !e.name.includes("KEY")).map(e => (
                    <div key={e.name} className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-[#0078D4] flex-shrink-0">{e.name}</span>
                      <span className="text-[#555]">=</span>
                      <span className="text-[#9e9e9e] truncate">{e.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "console" && (
            <div className="space-y-3">
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-4 min-h-64 font-mono text-xs">
                {!consoleData?.podName ? (
                  <div className="flex items-center gap-2 text-[#666]">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Waiting for pod...</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[#555]">Pod: {consoleData.podName}</p>
                    <p className="text-[#555]">Logs available at: {consoleData.logsUrl}</p>
                    <p className="text-green-400 mt-4">▶ Use the Pod Logs page for live streaming:</p>
                    <Link
                      href={`/logs?namespace=game-hub&pod=${consoleData.podName}&container=${consoleData.containerName}`}
                      className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 bg-[rgba(0,120,212,0.15)] hover:bg-[rgba(0,120,212,0.25)] text-[#0078D4] rounded-lg transition-colors"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Open Pod Logs →
                    </Link>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === "settings" && (
            <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4 space-y-3">
              <p className="text-xs text-[#9e9e9e] font-medium">Server Settings</p>
              <p className="text-xs text-[#555]">Edit environment variables by modifying the Deployment in the Kubernetes config editor.</p>
              <Link href={`/config?namespace=game-hub&resource=deployment&name=${name}`} className="inline-flex items-center gap-2 text-xs text-[#0078D4] hover:underline">
                <Settings className="w-3.5 h-3.5" />
                Open in Config Editor
              </Link>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
