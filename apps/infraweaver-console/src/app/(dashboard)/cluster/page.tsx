"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Server, Plus, RefreshCw, Zap, Link2, Loader2, Copy, Check, ChevronDown, Activity, Layers, BarChart2, GitBranch, Pencil, Save, X, Download, Settings2 } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import Link from "next/link";
import { MetricAreaChart } from "@/components/charts/AreaChart";
import { ClusterSettingsPanel } from "@/components/settings/cluster-settings-panel";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";

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

interface NodeMetric {
  name: string;
  cpuPct: number;
  memPct: number;
  cpuMillicores: number;
  memKi: number;
}

interface HPA {
  name: string;
  namespace: string;
  minReplicas: number;
  maxReplicas: number;
  currentReplicas: number;
  desiredReplicas: number;
  targetCpuPct: number;
}

interface DataPoint { time: string; value: number; }

function heatColor(pct: number): string {
  if (pct >= 80) return "bg-red-500/30 border-red-500/40";
  if (pct >= 60) return "bg-amber-500/20 border-amber-500/30";
  return "bg-green-500/10 border-green-500/20";
}

function heatBarColor(pct: number): string {
  if (pct >= 80) return "bg-red-500";
  if (pct >= 60) return "bg-amber-500";
  return "bg-emerald-500";
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { void navigator.clipboard.writeText(text); toast.success("Copied"); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="ml-2 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0">
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

function NodeHeatCard({ node, metric }: { node?: Node; metric?: NodeMetric }) {
  const [showTip, setShowTip] = useState(false);
  const cpuPct = metric?.cpuPct ?? 0;
  const memPct = metric?.memPct ?? 0;
  const isPulsing = cpuPct > 80 || memPct > 80;
  const name = node?.name ?? metric?.name ?? "unknown";

  return (
    <div
      className={cn("relative p-3 rounded-xl border cursor-pointer transition-all", heatColor(Math.max(cpuPct, memPct)))}
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
    >
      {isPulsing && (
        <span className="absolute top-2 right-2 flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
        </span>
      )}
      <p className="text-xs font-semibold text-white truncate mb-2">{name.replace("talos-", "")}</p>
      <div className="space-y-1.5">
        <div>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-400">CPU</span>
            <span className="text-slate-300">{cpuPct}%</span>
          </div>
          <div className="h-1 rounded-full bg-black/30 overflow-hidden">
            <div className={cn("h-full rounded-full transition-all", heatBarColor(cpuPct))} style={{ width: `${cpuPct}%` }} />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-400">MEM</span>
            <span className="text-slate-300">{memPct}%</span>
          </div>
          <div className="h-1 rounded-full bg-black/30 overflow-hidden">
            <div className={cn("h-full rounded-full transition-all", heatBarColor(memPct))} style={{ width: `${memPct}%` }} />
          </div>
        </div>
      </div>
      <AnimatePresence>
        {showTip && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="absolute z-20 bottom-full left-0 mb-2 w-44 bg-slate-900 border border-white/15 rounded-lg p-2.5 shadow-xl pointer-events-none">
            <p className="text-xs font-semibold text-white mb-1.5">{name}</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-slate-400">CPU</span><span className="text-white">{cpuPct}% ({metric?.cpuMillicores ?? 0}m)</span></div>
              <div className="flex justify-between"><span className="text-slate-400">Memory</span><span className="text-white">{memPct}%</span></div>
              {node && <div className="flex justify-between"><span className="text-slate-400">Version</span><span className="text-slate-300">{node.version}</span></div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function HPARow({ hpa, isAdmin, onSaved }: { hpa: HPA; isAdmin: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [minVal, setMinVal] = useState(hpa.minReplicas);
  const [maxVal, setMaxVal] = useState(hpa.maxReplicas);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/cluster/hpa", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: hpa.name, namespace: hpa.namespace, minReplicas: minVal, maxReplicas: maxVal }),
      });
      if (!res.ok) throw new Error("Failed to update HPA");
      toast.success(`HPA ${hpa.name} updated`);
      onSaved();
      setEditing(false);
    } catch {
      toast.error("Failed to update HPA");
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10 text-sm flex-wrap">
      <div className="flex-1 min-w-0">
        <p className="text-white font-medium truncate">{hpa.name}</p>
        <p className="text-xs text-slate-500">{hpa.namespace}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded">{hpa.currentReplicas}/{hpa.desiredReplicas} pods</span>
        {hpa.targetCpuPct > 0 && <span className="bg-slate-500/10 px-2 py-0.5 rounded">{hpa.targetCpuPct}% CPU target</span>}
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400">Min</label>
          <input type="number" min={1} value={minVal} onChange={e => setMinVal(+e.target.value)} className="w-14 bg-slate-800 border border-white/10 rounded px-2 py-0.5 text-sm text-white text-center focus:outline-none focus:border-indigo-500/50" />
          <label className="text-xs text-slate-400">Max</label>
          <input type="number" min={minVal} value={maxVal} onChange={e => setMaxVal(+e.target.value)} className="w-14 bg-slate-800 border border-white/10 rounded px-2 py-0.5 text-sm text-white text-center focus:outline-none focus:border-indigo-500/50" />
          <button onClick={handleSave} disabled={saving} className="p-1 rounded text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          </button>
          <button onClick={() => setEditing(false)} className="p-1 rounded text-slate-400 hover:bg-white/5 transition-colors"><X className="w-4 h-4" /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">{hpa.minReplicas}–{hpa.maxReplicas} replicas</span>
          {isAdmin && <button onClick={() => setEditing(true)} className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/5 transition-colors"><Pencil className="w-3.5 h-3.5" /></button>}
        </div>
      )}
    </motion.div>
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
  const [metricsRefreshSeconds, setMetricsRefreshSeconds] = useState(15);
  const [cordoningNode, setCordoningNode] = useState<string | null>(null);

  const [cpuHistory, setCpuHistory] = useState<DataPoint[]>([]);
  const [memHistory, setMemHistory] = useState<DataPoint[]>([]);

  const { data, isLoading, refetch } = useQuery<{ nodes: Node[] }>({
    queryKey: ["cluster", "nodes"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/nodes");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const { data: metricsData, refetch: refetchMetrics } = useQuery<{ metrics: NodeMetric[]; timestamp: string }>({
    queryKey: ["cluster", "metrics", metricsRefreshSeconds],
    queryFn: async () => {
      const res = await fetch("/api/cluster/metrics");
      return res.json();
    },
    staleTime: 10000,
    refetchInterval: metricsRefreshSeconds * 1000,
  });

  const { data: hpaData, refetch: refetchHpa } = useQuery<{ hpas: HPA[] }>({
    queryKey: ["cluster", "hpa"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/hpa");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  useEffect(() => {
    if (!metricsData?.metrics?.length) return;
    const avgCpu = Math.round(metricsData.metrics.reduce((a, m) => a + m.cpuPct, 0) / metricsData.metrics.length);
    const avgMem = Math.round(metricsData.metrics.reduce((a, m) => a + m.memPct, 0) / metricsData.metrics.length);
    const time = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    setCpuHistory(prev => [...prev.slice(-19), { time, value: avgCpu }]);
    setMemHistory(prev => [...prev.slice(-19), { time, value: avgMem }]);
  }, [metricsData]);

  const nodes = data?.nodes ?? [];
  const metrics = metricsData?.metrics ?? [];
  const hpas = hpaData?.hpas ?? [];
  const NODE_PAGE_SIZE = 5;
  const [showAllNodes, setShowAllNodes] = useState(false);
  const displayNodes = showAllNodes ? nodes : nodes.slice(0, NODE_PAGE_SIZE);

  const metricsMap = Object.fromEntries(metrics.map(m => [m.name, m]));

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

  const handleToggleCordon = async (node: Node) => {
    setCordoningNode(node.name);
    try {
      const res = await fetch("/api/cluster/cordon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node: node.name, cordon: !node.unschedulable }),
      });
      const result = await res.json() as { error?: string };
      if (!res.ok) throw new Error(result.error ?? "Failed to update node scheduling");
      toast.success(node.unschedulable ? `Uncordoned ${node.name}` : `Cordoned ${node.name}`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update node scheduling");
    } finally {
      setCordoningNode(null);
    }
  };

  const handleExportYaml = () => {
    window.location.href = "/api/cluster/export";
  };

  return (
    <div>
      <PageHeader icon={Server} title="Cluster Nodes" subtitle="Node management and cluster overview" />
      <div className="relative mb-4 overflow-hidden rounded-xl sm:mb-6">
        <div className="relative flex flex-wrap items-start justify-between gap-3 p-4 sm:gap-4 sm:p-5">
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
              <Server className="w-5 h-5 text-indigo-400" />
              Cluster Management
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">Node status and cluster operations</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Link href="/node-top" className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <Activity className="w-3.5 h-3.5" />
              Node Top
            </Link>
            <Link href="/pipelines" className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <GitBranch className="w-3.5 h-3.5" />
              Pipelines
            </Link>
            <button onClick={handleExportYaml} className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <Download className="w-3.5 h-3.5" />
              Export YAML
            </button>
            <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300">
              <span className="text-xs text-slate-400">Metrics</span>
              <select
                value={metricsRefreshSeconds}
                onChange={(event) => setMetricsRefreshSeconds(Number(event.target.value))}
                className="bg-transparent text-sm text-white focus:outline-none"
              >
                {[15, 30, 60].map((seconds) => (
                  <option key={seconds} value={seconds} className="bg-slate-900">{seconds}s</option>
                ))}
              </select>
            </div>
            <button onClick={() => { void refetch(); void refetchMetrics(); void refetchHpa(); }} className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4 sm:space-y-6">
        {metrics.length > 0 && (
          <CollapsibleSection title="Node Resource Heatmap" storageKey="cluster-heatmap" badge={<BarChart2 className="w-4 h-4 text-indigo-400 flex-shrink-0" />}>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {metrics.map(m => (
                <NodeHeatCard key={m.name} node={nodes.find(n => n.name === m.name)} metric={m} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {(cpuHistory.length > 1 || memHistory.length > 1) && (
          <CollapsibleSection title="Live Metrics" storageKey="cluster-live-metrics" badge={<Activity className="w-4 h-4 text-emerald-400 flex-shrink-0" />}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">Metrics refresh interval: every {metricsRefreshSeconds}s</p>
              <RefreshCountdown intervalSeconds={metricsRefreshSeconds} resetKey={metricsData?.timestamp ?? metricsRefreshSeconds} />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <MetricAreaChart data={cpuHistory} label="Average Cluster CPU" unit="%" color="emerald" warnAt={70} critAt={90} />
              <MetricAreaChart data={memHistory} label="Average Cluster Memory" unit="%" color="indigo" warnAt={70} critAt={90} />
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection
          title="Cluster Nodes"
          count={nodes.length}
          storageKey="cluster-nodes"
          badge={<Server className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
        >
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[...Array(3)].map((_, i) => <div key={i} className="h-36 rounded-xl shimmer-bg" />)}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {displayNodes.map((node, i) => (
                  <motion.div
                    key={node.name}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.08 }}
                    className={cn(
                      "p-3 md:p-4 rounded-xl border touch-manipulation active:scale-95 transition-transform",
                      node.status === "Ready" ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20",
                      node.unschedulable && "opacity-60"
                    )}
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <span className={cn("w-2 h-2 rounded-full flex-shrink-0", node.status === "Ready" ? "bg-green-500" : "bg-red-500")} />
                      <span className="text-sm font-semibold text-white truncate">{node.name}</span>
                      {node.unschedulable && <span className="text-xs text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">Cordoned</span>}
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between gap-2"><span className="text-slate-500">IP</span><span className="flex items-center text-slate-300 font-mono">{node.ip}<CopyBtn text={node.ip} /></span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Role</span><span className="text-slate-300">{node.roles.join(", ") || "worker"}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Version</span><span className="text-slate-300 font-mono">{node.version}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">CPU</span><span className="text-slate-300">{node.cpu} cores {metricsMap[node.name] ? `(${metricsMap[node.name].cpuPct}% used)` : ""}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Memory</span><span className="text-slate-300">{node.memory} {metricsMap[node.name] ? `(${metricsMap[node.name].memPct}%)` : ""}</span></div>
                      {node.age && <div className="flex justify-between"><span className="text-slate-500">Uptime</span><span className="text-slate-300">{timeAgo(node.age)}</span></div>}
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => void handleToggleCordon(node)}
                        disabled={cordoningNode === node.name}
                        className={cn(
                          "mt-3 w-full rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                          node.unschedulable
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15",
                          cordoningNode === node.name && "opacity-60"
                        )}
                      >
                        {cordoningNode === node.name ? "Updating..." : node.unschedulable ? "Uncordon node" : "Cordon node"}
                      </button>
                    )}
                  </motion.div>
                ))}
              </div>
              {nodes.length > NODE_PAGE_SIZE && (
                <button onClick={() => setShowAllNodes(v => !v)} className="mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-400 hover:text-white hover:bg-white/8 transition-colors">
                  <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showAllNodes && "rotate-180")} />
                  {showAllNodes ? "Show fewer" : `Show ${nodes.length - NODE_PAGE_SIZE} more node${nodes.length - NODE_PAGE_SIZE !== 1 ? "s" : ""}`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>

        {hpas.length > 0 && (
          <CollapsibleSection title="Horizontal Pod Autoscalers" count={hpas.length} storageKey="cluster-hpa" badge={<Layers className="w-4 h-4 text-violet-400 flex-shrink-0" />}>
            <div className="space-y-2">
              {hpas.map(hpa => (
                <HPARow key={`${hpa.namespace}/${hpa.name}`} hpa={hpa} isAdmin={isAdmin} onSaved={() => { void refetchHpa(); }} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {isAdmin && (
          <CollapsibleSection
            title="Node & Service Configuration"
            storageKey="cluster-config-panel"
            badge={<Settings2 className="w-4 h-4 text-purple-400 flex-shrink-0" />}
            defaultOpen
          >
            <ClusterSettingsPanel embedded />
          </CollapsibleSection>
        )}

        {isAdmin && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="rounded-xl border border-white/10 bg-white/5 p-4 sm:p-5">
            <h3 className="mb-4 text-sm font-semibold text-white">Quick Cluster Actions</h3>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <button onClick={() => setShowSyncConfirm(true)} disabled={syncing} className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/20 px-4 py-2.5 text-sm text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50 sm:w-auto">
                {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                Sync All ArgoCD Apps
              </button>
              <button onClick={() => setShowRolloutConfirm(true)} disabled={rolling} className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/20 px-4 py-2.5 text-sm text-orange-300 transition-colors hover:bg-orange-500/30 disabled:opacity-50 sm:w-auto">
                {rolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Force Redeploy InfraWeaver
              </button>
              <button onClick={() => setShowAddNode(true)} className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/20 px-4 py-2.5 text-sm text-green-300 transition-colors hover:bg-green-500/30 sm:w-auto">
                <Plus className="w-4 h-4" />
                Add Node Wizard
              </button>
              <Link href="/config" className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:bg-white/10 hover:text-white sm:w-auto">
                <Link2 className="w-4 h-4" />
                Platform YAML Editor
              </Link>
            </div>
          </motion.div>
        )}

        {showAddNode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setShowAddNode(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-slate-900 border border-white/10 rounded-xl shadow-2xl overflow-hidden">
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mt-3" />
              <div className="p-5">
                <h3 className="text-base font-semibold text-white mb-1">Add New Talos Node</h3>
                <p className="text-xs text-slate-400 mb-4">Follow these steps to add a new control-plane node</p>
                <div className="mb-3">
                  <label className="text-xs text-slate-400 mb-1 block">New Node IP Address</label>
                  <input value={newIp} onChange={e => setNewIp(e.target.value)} className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-indigo-500/50" placeholder="10.10.0.93" />
                </div>
                <div className="space-y-3">
                  {[
                    { step: 1, label: "Boot machine with Talos ISO", cmd: null as string | null, note: "Download from https://factory.talos.dev" },
                    { step: 2, label: "Apply control-plane config", cmd: `talosctl apply-config --insecure --nodes ${newIp} --file controlplane.yaml`, note: null as string | null },
                    { step: 3, label: "Wait for node to join", cmd: `kubectl get nodes --watch`, note: null as string | null },
                    { step: 4, label: "Verify node is Ready", cmd: `kubectl get nodes -o wide`, note: null as string | null },
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
                <button onClick={() => setShowAddNode(false)} className="mt-5 w-full py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">Close</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </div>

      <ConfirmDialog open={showSyncConfirm} onConfirm={handleSyncAll} onCancel={() => setShowSyncConfirm(false)} title="Sync All ArgoCD Apps?" description="This will trigger a sync for all ArgoCD applications." confirmText="Sync All" />
      <ConfirmDialog open={showRolloutConfirm} onConfirm={handleRollout} onCancel={() => setShowRolloutConfirm(false)} title="Force Redeploy InfraWeaver?" description="This will restart all InfraWeaver console pods. The console will be briefly unavailable." confirmText="REDEPLOY" danger requireTyping="REDEPLOY" />
    </div>
  );
}
