"use client";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Server, Plus, RefreshCw, Zap, Link2, Loader2, Copy, Check } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { toast } from "sonner";
import Link from "next/link";

interface Node {
  name: string;
  status: "Ready" | "NotReady";
  roles: string[];
  version: string;
  ip: string;
  cpu: string;
  memory: string;
  unschedulable: boolean;
  age: string | null;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="ml-2 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="flex items-center bg-slate-950 rounded-lg border border-white/5 p-3 font-mono text-xs text-slate-300 overflow-x-auto">
      <code className="flex-1">{code}</code>
      <CopyBtn text={code} />
    </div>
  );
}

export default function ClusterPage() {
  const { isAdmin } = useRBAC();
  const qc = useQueryClient();
  const [showSyncConfirm, setShowSyncConfirm] = useState(false);
  const [showRolloutConfirm, setShowRolloutConfirm] = useState(false);
  const [showAddNode, setShowAddNode] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [newIp, setNewIp] = useState("10.10.0.93");

  const { data, isLoading, refetch } = useQuery<{ nodes: Node[] }>({
    queryKey: ["cluster", "nodes"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/nodes");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const nodes = data?.nodes ?? [];

  const handleSyncAll = async () => {
    setSyncing(true);
    setShowSyncConfirm(false);
    try {
      const res = await fetch("/api/argocd/sync-all", { method: "POST" });
      const result = await res.json() as { ok?: boolean; synced?: string[]; errors?: string[]; total?: number };
      if (result.synced !== undefined) {
        toast.success(`Synced ${result.synced.length} ArgoCD apps`);
        qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
      } else {
        toast.error("Sync failed");
      }
    } catch {
      toast.error("Sync all failed");
    } finally {
      setSyncing(false);
    }
  };

  const handleRollout = async () => {
    setRolling(true);
    setShowRolloutConfirm(false);
    try {
      await fetch("/api/cluster/rollout", { method: "POST" });
      toast.success("Rollout triggered for infraweaver-console");
    } catch {
      toast.error("Rollout failed");
    } finally {
      setRolling(false);
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
            <Server className="w-5 h-5 text-indigo-400" />
            Cluster Management
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Node status and cluster operations</p>
        </div>
        <button onClick={() => refetch()} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      <div className="space-y-6">
        {/* Nodes */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-4">Cluster Nodes ({nodes.length})</h3>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[...Array(3)].map((_, i) => <div key={i} className="h-36 rounded-xl shimmer-bg" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {nodes.map((node, i) => (
                <motion.div
                  key={node.name}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: i * 0.08 }}
                  className={cn(
                    "p-4 rounded-xl border",
                    node.status === "Ready"
                      ? "bg-green-500/5 border-green-500/20"
                      : "bg-red-500/5 border-red-500/20",
                    node.unschedulable && "opacity-60"
                  )}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span className={cn("w-2 h-2 rounded-full flex-shrink-0", node.status === "Ready" ? "bg-green-500" : "bg-red-500")} />
                    <span className="text-sm font-semibold text-white truncate">{node.name}</span>
                    {node.unschedulable && <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">Cordoned</span>}
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex justify-between"><span className="text-slate-500">IP</span><span className="text-slate-300 font-mono">{node.ip}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Role</span><span className="text-slate-300">{node.roles.join(", ") || "worker"}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Version</span><span className="text-slate-300 font-mono">{node.version}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">CPU</span><span className="text-slate-300">{node.cpu} cores</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Memory</span><span className="text-slate-300">{node.memory}</span></div>
                    {node.age && <div className="flex justify-between"><span className="text-slate-500">Age</span><span className="text-slate-300">{timeAgo(node.age)}</span></div>}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>

        {/* Quick Actions */}
        {isAdmin && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="bg-white/5 border border-white/10 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-white mb-4">Quick Cluster Actions</h3>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => setShowSyncConfirm(true)}
                disabled={syncing}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
              >
                {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Sync All ArgoCD Apps
              </button>
              <button
                onClick={() => setShowRolloutConfirm(true)}
                disabled={rolling}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-orange-500/20 border border-orange-500/30 text-sm text-orange-300 hover:bg-orange-500/30 transition-colors disabled:opacity-50"
              >
                {rolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Force Redeploy InfraWeaver
              </button>
              <button
                onClick={() => setShowAddNode(true)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-green-500/20 border border-green-500/30 text-sm text-green-300 hover:bg-green-500/30 transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Node Wizard
              </button>
              <Link
                href="/config"
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Link2 className="w-4 h-4" />
                Platform YAML Editor
              </Link>
            </div>
          </motion.div>
        )}

        {/* Add Node Wizard Modal */}
        {showAddNode && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowAddNode(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              onClick={e => e.stopPropagation()}
              className="w-full max-w-lg bg-slate-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden"
            >
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mt-3" />
              <div className="p-5">
                <h3 className="text-base font-semibold text-white mb-1">Add New Talos Node</h3>
                <p className="text-xs text-slate-400 mb-4">Follow these steps to add a new control-plane node</p>
                <div className="mb-3">
                  <label className="text-xs text-slate-400 mb-1 block">New Node IP Address</label>
                  <input
                    value={newIp}
                    onChange={e => setNewIp(e.target.value)}
                    className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-indigo-500/50"
                    placeholder="10.10.0.93"
                  />
                </div>
                <div className="space-y-3">
                  {[
                    { step: 1, label: "Boot machine with Talos ISO", cmd: null, note: "Download from https://factory.talos.dev" },
                    { step: 2, label: "Apply control-plane config", cmd: `talosctl apply-config --insecure --nodes ${newIp} --file controlplane.yaml`, note: null },
                    { step: 3, label: "Wait for node to join", cmd: `kubectl get nodes --watch`, note: null },
                    { step: 4, label: "Verify node is Ready", cmd: `kubectl get nodes -o wide`, note: null },
                  ].map(s => (
                    <div key={s.step} className="flex gap-3">
                      <div className="w-6 h-6 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-xs font-bold text-indigo-400 flex-shrink-0 mt-0.5">{s.step}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200 mb-1">{s.label}</p>
                        {s.cmd && <CodeBlock code={s.cmd} />}
                        {s.note && <p className="text-xs text-slate-500 mt-1">{s.note}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={() => setShowAddNode(false)} className="mt-5 w-full py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </div>

      <ConfirmDialog
        open={showSyncConfirm}
        onConfirm={handleSyncAll}
        onCancel={() => setShowSyncConfirm(false)}
        title="Sync All ArgoCD Apps?"
        description="This will trigger a sync for all ArgoCD applications. Apps with auto-sync disabled will be forced to sync."
        confirmText="Sync All"
      />
      <ConfirmDialog
        open={showRolloutConfirm}
        onConfirm={handleRollout}
        onCancel={() => setShowRolloutConfirm(false)}
        title="Force Redeploy InfraWeaver?"
        description="This will restart all InfraWeaver console pods. The console will be briefly unavailable."
        confirmText="REDEPLOY"
        danger
        requireTyping="REDEPLOY"
      />
    </div>
  );
}
