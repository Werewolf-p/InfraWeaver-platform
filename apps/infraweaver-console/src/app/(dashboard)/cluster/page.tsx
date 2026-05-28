"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, useMemo, useRef } from "react";
import { Server, Plus, Lock, RefreshCw, Zap, Link2, Loader2, Copy, Check, ChevronDown, Activity, Layers, BarChart2, GitBranch, Pencil, Save, X, Download, Settings2, ArrowRightLeft, MemoryStick, AlertTriangle, Bell, Globe, Radio, ShieldCheck, ShieldX } from "lucide-react";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { CopyButton } from "@/components/ui/copy-button";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { SegmentedBar } from "@/components/ui/segmented-bar";
import { toast } from "@/lib/notify";
import Link from "next/link";
import { MetricAreaChart } from "@/components/charts/AreaChart";
import { MetricSparkline, type SparklinePoint } from "@/components/charts/sparkline";
import { ClusterSettingsPanel } from "@/components/settings/cluster-settings-panel";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { useCluster } from "@/contexts/cluster-context";

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

interface NodePodInfo {
  name: string;
  namespace: string;
  node: string;
  cpuMillicores: number;
  memoryMi: number;
  ownerKind: string | null;
  ownerName: string | null;
  status: string;
  canMigrate: boolean;
}

interface NodeCapacityInfo {
  name: string;
  allocatableMi: number;
  usedMi: number;
  availableMi: number;
  usedPct: number;
  status: "Ready" | "NotReady";
}

interface DataPoint { time: string; value: number; }

interface Quota {
  namespace: string;
  name: string;
  hard: Record<string, string>;
  used: Record<string, string>;
}

interface ClusterEvent {
  name: string;
  namespace: string;
  reason: string;
  message: string;
  type: string;
  count: number;
  lastTimestamp: string | null;
  involvedObject: { kind: string; name: string };
}

interface PodDisruptionBudgetSummary {
  name: string;
  namespace: string;
  minAvailable: string | number | null;
  maxUnavailable: string | number | null;
  currentHealthy: number;
  desiredHealthy: number;
  expectedPods: number;
  disruptionsAllowed: number;
  selector: Record<string, string>;
}

function parseQuotaValue(val: string): number {
  if (!val) return 0;
  if (val.endsWith("m")) return parseFloat(val) / 1000;
  if (val.endsWith("Ki")) return parseFloat(val) / (1024 * 1024);
  if (val.endsWith("Mi")) return parseFloat(val) / 1024;
  if (val.endsWith("Gi")) return parseFloat(val);
  return parseFloat(val);
}

function quotaPct(used: string, hard: string): number {
  const u = parseQuotaValue(used);
  const h = parseQuotaValue(hard);
  if (h === 0) return 0;
  return Math.min(100, Math.round((u / h) * 100));
}

// ── Pod Migration Modal ───────────────────────────────────────────────────────

function MigratePodModal({
  pod,
  nodes,
  onClose,
  onMigrated,
}: {
  pod: NodePodInfo;
  nodes: NodeCapacityInfo[];
  onClose: () => void;
  onMigrated: () => void;
}) {
  const [targetNode, setTargetNode] = useState<string>("");
  const [migrating, setMigrating] = useState(false);

  const eligibleNodes = nodes.filter(n => n.name !== pod.node && n.status === "Ready");

  const willFit = (node: NodeCapacityInfo) =>
    node.availableMi >= pod.memoryMi + 512;

  const handleMigrate = async () => {
    if (!targetNode) return;
    setMigrating(true);
    try {
      const res = await fetch("/api/cluster/migrate-pod", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: pod.namespace, podName: pod.name, targetNode }),
      });
      const result = await res.json() as { ok?: boolean; error?: string; movedTo?: string; availableMi?: number; neededMi?: number };
      if (!res.ok) throw new Error(result.error ?? "Migration failed");
      toast.success(`Moved ${pod.name} → ${targetNode}`);
      onMigrated();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Migration failed");
    } finally {
      setMigrating(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-md bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden"
      >
        <div className="p-5 border-b border-gray-200 dark:border-white/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-indigo-400" />
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">Migrate Pod</h3>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-gray-900 dark:hover:text-white transition-colors"><X className="w-4 h-4" /></button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">{pod.namespace}/{pod.name}</p>
        </div>

        <div className="p-5 space-y-4">
          <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-500 dark:text-slate-400">Current node</span>
              <span className="text-gray-900 dark:text-white font-mono">{pod.node}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 dark:text-slate-400">Pod memory usage</span>
              <span className="text-gray-900 dark:text-white">{pod.memoryMi > 0 ? `~${pod.memoryMi} Mi` : "unknown"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500 dark:text-slate-400">Owner</span>
              <span className="text-slate-700 dark:text-slate-300">{pod.ownerKind}: {pod.ownerName}</span>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2 block">Target node</label>
            <div className="space-y-2">
              {eligibleNodes.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-3">No other Ready nodes available</p>
              )}
              {eligibleNodes.map(node => {
                const fits = willFit(node);
                const pctAfter = node.allocatableMi > 0
                  ? Math.round(((node.usedMi + pod.memoryMi) / node.allocatableMi) * 100)
                  : 0;
                return (
                  <button
                    key={node.name}
                    disabled={!fits}
                    onClick={() => setTargetNode(node.name)}
                    className={cn(
                      "w-full flex items-center justify-between p-3 rounded-lg border text-left transition-all",
                      targetNode === node.name
                        ? "border-indigo-500/60 bg-indigo-500/15"
                        : fits
                          ? "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 hover:border-white/20 hover:bg-white/8"
                          : "border-red-500/20 bg-red-500/5 opacity-60 cursor-not-allowed",
                    )}
                  >
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{node.name.replace("talos-", "")}</p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        {node.availableMi} Mi free of {node.allocatableMi} Mi allocatable
                      </p>
                    </div>
                    <div className="text-right">
                      {fits ? (
                        <span className={cn("text-xs px-2 py-0.5 rounded",
                          pctAfter >= 85 ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/15 text-emerald-400"
                        )}>
                          → {pctAfter}% after
                        </span>
                      ) : (
                        <span className="text-xs flex items-center gap-1 text-red-400">
                          <AlertTriangle className="w-3 h-3" />
                          Not enough RAM
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="p-5 pt-0 flex gap-3">
          <button
            onClick={handleMigrate}
            disabled={!targetNode || migrating}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
          >
            {migrating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRightLeft className="w-4 h-4" />}
            {migrating ? "Migrating…" : "Migrate Pod"}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 rounded-lg border border-gray-200 dark:border-white/10 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Node Pod List ─────────────────────────────────────────────────────────────

function NodePodSection({
  nodeCapacity,
  pods,
  allNodes,
  isAdmin,
  onMigrated,
}: {
  nodeCapacity: NodeCapacityInfo;
  pods: NodePodInfo[];
  allNodes: NodeCapacityInfo[];
  isAdmin: boolean;
  onMigrated: () => void;
}) {
  const [migrating, setMigrating] = useState<NodePodInfo | null>(null);
  const [showAll, setShowAll] = useState(false);
  const PAGE = 5;

  const movable = pods.filter(p => p.canMigrate);
  const displayed = showAll ? pods : pods.slice(0, PAGE);
  const pct = nodeCapacity.usedPct;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 overflow-hidden">
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-white/10">
        <div className="flex items-center gap-2">
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0", nodeCapacity.status === "Ready" ? "bg-green-500" : "bg-red-500")} />
          <span className="text-sm font-semibold text-gray-900 dark:text-white">{nodeCapacity.name.replace("talos-", "")}</span>
          <span className="text-xs text-slate-500">{pods.length} pods</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <MemoryStick className="w-3 h-3" />
            <span>{nodeCapacity.usedMi} / {nodeCapacity.allocatableMi} Mi</span>
            <span className={cn("px-1.5 py-0.5 rounded font-medium",
              pct >= 85 ? "bg-red-500/20 text-red-300" :
              pct >= 70 ? "bg-amber-500/20 text-amber-300" :
              "bg-emerald-500/15 text-emerald-400"
            )}>
              {pct}%
            </span>
          </div>
        </div>
      </div>

      <div className="divide-y divide-white/5">
        {displayed.map(pod => (
          <div key={`${pod.namespace}/${pod.name}`} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-gray-900 dark:text-white font-mono truncate">{pod.name}</span>
              </div>
              <span className="text-[11px] text-slate-500">{pod.namespace}</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 flex-shrink-0">
              {pod.memoryMi > 0 && (
                <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{pod.memoryMi} Mi</span>
              )}
              {pod.cpuMillicores > 0 && (
                <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{pod.cpuMillicores}m</span>
              )}
              {isAdmin && pod.canMigrate && (
                <button
                  onClick={() => setMigrating(pod)}
                  className="flex items-center gap-1 px-2 py-1 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20 transition-colors"
                >
                  <ArrowRightLeft className="w-3 h-3" />
                  Move
                </button>
              )}
            </div>
          </div>
        ))}
        {pods.length === 0 && (
          <p className="text-xs text-slate-500 text-center py-4">No running pods</p>
        )}
      </div>

      {pods.length > PAGE && (
        <button
          onClick={() => setShowAll(v => !v)}
          className="w-full flex items-center justify-center gap-1 py-2 text-xs text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 transition-colors border-t border-gray-200 dark:border-white/10"
        >
          <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", showAll && "rotate-180")} />
          {showAll ? `Show fewer` : `${pods.length - PAGE} more pods`}
        </button>
      )}

      {movable.length > 0 && !showAll && pods.length <= PAGE && (
        <div className="px-3 py-2 border-t border-gray-200 dark:border-white/10">
          <p className="text-[11px] text-slate-500">{movable.length} pod{movable.length !== 1 ? "s" : ""} can be migrated</p>
        </div>
      )}

      <AnimatePresence>
        {migrating && (
          <MigratePodModal
            pod={migrating}
            nodes={allNodes}
            onClose={() => setMigrating(null)}
            onMigrated={onMigrated}
          />
        )}
      </AnimatePresence>
    </div>
  );
}


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
    <button onClick={() => { void navigator.clipboard.writeText(text); toast.success("Copied"); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="ml-2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors flex-shrink-0">
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="flex items-center bg-slate-100 dark:bg-slate-950 rounded-lg border border-gray-200 dark:border-white/5 p-3 font-mono text-xs text-slate-700 dark:text-slate-300 overflow-x-auto">
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
      <p className="text-xs font-semibold text-gray-900 dark:text-white truncate mb-2">{name.replace("talos-", "")}</p>
      <div className="space-y-1.5">
        <div>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-500 dark:text-slate-400">CPU</span>
            <span className="text-slate-700 dark:text-slate-300">{cpuPct}%</span>
          </div>
          <div className="h-1 rounded-full bg-black/30 overflow-hidden">
            <div className={cn("h-full rounded-full transition-all", heatBarColor(cpuPct))} style={{ width: `${cpuPct}%` }} />
          </div>
        </div>
        <div>
          <div className="flex justify-between text-[10px] mb-0.5">
            <span className="text-slate-500 dark:text-slate-400">MEM</span>
            <span className="text-slate-700 dark:text-slate-300">{memPct}%</span>
          </div>
          <div className="h-1 rounded-full bg-black/30 overflow-hidden">
            <div className={cn("h-full rounded-full transition-all", heatBarColor(memPct))} style={{ width: `${memPct}%` }} />
          </div>
        </div>
      </div>
      <AnimatePresence>
        {showTip && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="absolute z-20 bottom-full left-0 mb-2 w-44 bg-slate-100 dark:bg-slate-900 border border-white/15 rounded-lg p-2.5 shadow-xl pointer-events-none">
            <p className="text-xs font-semibold text-gray-900 dark:text-white mb-1.5">{name}</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">CPU</span><span className="text-gray-900 dark:text-white">{cpuPct}% ({metric?.cpuMillicores ?? 0}m)</span></div>
              <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Memory</span><span className="text-gray-900 dark:text-white">{memPct}%</span></div>
              {node && <div className="flex justify-between"><span className="text-slate-500 dark:text-slate-400">Version</span><span className="text-slate-700 dark:text-slate-300">{node.version}</span></div>}
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
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 p-3 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm flex-wrap">
      <div className="flex-1 min-w-0">
        <p className="text-gray-900 dark:text-white font-medium truncate">{hpa.name}</p>
        <p className="text-xs text-slate-500">{hpa.namespace}</p>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded">{hpa.currentReplicas}/{hpa.desiredReplicas} pods</span>
        {hpa.targetCpuPct > 0 && <span className="bg-slate-500/10 px-2 py-0.5 rounded">{hpa.targetCpuPct}% CPU target</span>}
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500 dark:text-slate-400">Min</label>
          <input type="number" min={1} value={minVal} onChange={e => setMinVal(+e.target.value)} className="w-14 bg-slate-100 dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded px-2 py-0.5 text-sm text-gray-900 dark:text-white text-center focus:outline-none focus:border-indigo-500/50" />
          <label className="text-xs text-slate-500 dark:text-slate-400">Max</label>
          <input type="number" min={minVal} value={maxVal} onChange={e => setMaxVal(+e.target.value)} className="w-14 bg-slate-100 dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded px-2 py-0.5 text-sm text-gray-900 dark:text-white text-center focus:outline-none focus:border-indigo-500/50" />
          <button onClick={handleSave} disabled={saving} className="p-1 rounded text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          </button>
          <button onClick={() => setEditing(false)} className="p-1 rounded text-slate-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"><X className="w-4 h-4" /></button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">{hpa.minReplicas}–{hpa.maxReplicas} replicas</span>
          {isAdmin && <button onClick={() => setEditing(true)} className="p-1 rounded text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"><Pencil className="w-3.5 h-3.5" /></button>}
        </div>
      )}
    </motion.div>
  );
}

export default function ClusterPage() {
  const { activeId } = useCluster();
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
  const [drainingNode, setDrainingNode] = useState<string | null>(null);
  const [cordonTarget, setCordonTarget] = useState<Node | null>(null);
  const [drainTarget, setDrainTarget] = useState<Node | null>(null);
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeFilter, setNodeFilter] = useState<"all" | "ready" | "cordoned" | "pressure">("all");
  const searchRef = useRef<HTMLInputElement>(null);

  const [cpuHistory, setCpuHistory] = useState<DataPoint[]>([]);
  const [memHistory, setMemHistory] = useState<DataPoint[]>([]);
  const [nodeHistory, setNodeHistory] = useState<Record<string, { cpu: SparklinePoint[]; memory: SparklinePoint[] }>>({});

  const { data, isLoading, refetch } = useQuery<{ nodes: Node[] }>({
    queryKey: ["cluster", "nodes"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/nodes");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const { data: nodePodData, refetch: refetchNodePods } = useQuery<{
    nodes: NodeCapacityInfo[];
    pods: NodePodInfo[];
  }>({
    queryKey: ["cluster", "node-pods"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/node-pods");
      return res.json();
    },
    staleTime: 20000,
    refetchInterval: 30000,
  });

  const { data: metricsData, refetch: refetchMetrics } = useQuery<{ metrics: NodeMetric[]; timestamp: string }>({
    queryKey: ["cluster", "metrics", metricsRefreshSeconds],
    queryFn: async () => {
      const res = await fetch("/api/cluster/metrics");
      const payload = await res.json() as { metrics: NodeMetric[]; timestamp: string };
      if (payload.metrics?.length) {
        const avgCpuValue = Math.round(payload.metrics.reduce((a, m) => a + m.cpuPct, 0) / payload.metrics.length);
        const avgMemValue = Math.round(payload.metrics.reduce((a, m) => a + m.memPct, 0) / payload.metrics.length);
        const time = new Date(payload.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        setCpuHistory(prev => [...prev.slice(-19), { time, value: avgCpuValue }]);
        setMemHistory(prev => [...prev.slice(-19), { time, value: avgMemValue }]);
      }
      return payload;
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

  const { data: quotaData, refetch: refetchQuota } = useQuery<{ quotas: Quota[] }>({
    queryKey: ["cluster", "quota", "cluster-page"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/quota");
      if (!res.ok) throw new Error("Failed to fetch cluster quotas");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const { data: eventData, refetch: refetchEvents } = useQuery<{ events: ClusterEvent[] }>({
    queryKey: ["cluster", "events", "cluster-page"],
    queryFn: async () => {
      const res = await fetch("/api/events");
      if (!res.ok) throw new Error("Failed to fetch recent events");
      return res.json();
    },
    staleTime: 15000,
    refetchInterval: 30000,
  });

  const { data: pdbData, refetch: refetchPdbs } = useQuery<{ pdbs: PodDisruptionBudgetSummary[] }>({
    queryKey: ["cluster", "pdbs"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/pdbs");
      if (!res.ok) throw new Error("Failed to fetch PodDisruptionBudgets");
      return res.json();
    },
    staleTime: 30000,
    refetchInterval: 60000,
  });

  const nodes = useMemo(() => data?.nodes ?? [], [data?.nodes]);
  const metrics = useMemo(() => metricsData?.metrics ?? [], [metricsData?.metrics]);
  const hpas = useMemo(() => hpaData?.hpas ?? [], [hpaData?.hpas]);
  const NODE_PAGE_SIZE = 5;
  const [showAllNodes, setShowAllNodes] = useState(false);

  const metricsMap = Object.fromEntries(metrics.map(m => [m.name, m]));

  useEffect(() => {
    if (!metricsData?.metrics?.length) return;
    const label = new Date(metricsData.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const frame = window.requestAnimationFrame(() => {
      setNodeHistory((prev) => {
        const next = { ...prev };
        for (const metric of metricsData.metrics) {
          const current = next[metric.name] ?? { cpu: [], memory: [] };
          next[metric.name] = {
            cpu: [...current.cpu.slice(-11), { label, value: metric.cpuPct }],
            memory: [...current.memory.slice(-11), { label, value: metric.memPct }],
          };
        }
        return next;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [metricsData]);

  // Group pods by node for the migration view
  const podsByNode = useMemo(() => {
    const map: Record<string, NodePodInfo[]> = {};
    for (const pod of nodePodData?.pods ?? []) {
      if (!map[pod.node]) map[pod.node] = [];
      map[pod.node].push(pod);
    }
    return map;
  }, [nodePodData?.pods]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setNodeSearch("");
        setNodeFilter("all");
        setShowAddNode(false);
        setCordonTarget(null);
        setDrainTarget(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const filteredNodes = useMemo(() => {
    const query = nodeSearch.trim().toLowerCase();
    return nodes.filter((node) => {
      const metric = metricsMap[node.name];
      const pressure = Math.max(metric?.cpuPct ?? 0, metric?.memPct ?? 0);
      const matchesQuery = !query || node.name.toLowerCase().includes(query) || node.ip.toLowerCase().includes(query) || node.roles.join(" ").toLowerCase().includes(query);
      const matchesFilter = nodeFilter === "all"
        || (nodeFilter === "ready" && node.status === "Ready")
        || (nodeFilter === "cordoned" && node.unschedulable)
        || (nodeFilter === "pressure" && pressure >= 70);
      return matchesQuery && matchesFilter;
    });
  }, [metricsMap, nodeFilter, nodeSearch, nodes]);

  const displayNodes = showAllNodes ? filteredNodes : filteredNodes.slice(0, NODE_PAGE_SIZE);
  const cordonedNodes = nodes.filter((node) => node.unschedulable);
  const totalMigratablePods = (nodePodData?.pods ?? []).filter(p => p.canMigrate).length;
  const readyNodesCount = nodes.filter(node => node.status === "Ready").length;
  const avgCpu = metrics.length > 0 ? Math.round(metrics.reduce((sum, metric) => sum + metric.cpuPct, 0) / metrics.length) : 0;
  const avgMem = metrics.length > 0 ? Math.round(metrics.reduce((sum, metric) => sum + metric.memPct, 0) / metrics.length) : 0;
  const hotQuotas = (quotaData?.quotas ?? [])
    .map((quota) => {
      const peak = Math.max(...Object.keys(quota.hard).map(key => quotaPct(quota.used[key] ?? "0", quota.hard[key])), 0);
      return { ...quota, peak };
    })
    .sort((a, b) => b.peak - a.peak)
    .slice(0, 4);
  const recentEvents = (eventData?.events ?? []).slice(0, 6);
  const pdbs = useMemo(() => pdbData?.pdbs ?? [], [pdbData?.pdbs]);
  const protectedPdbs = pdbs.filter((pdb) => pdb.disruptionsAllowed > 0).length;
  const blockedPdbs = pdbs.filter((pdb) => pdb.disruptionsAllowed === 0).length;
  const pdbsAtRisk = pdbs.filter((pdb) => pdb.currentHealthy < pdb.desiredHealthy).length;

  if (activeId === "all") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Globe className="mb-4 h-10 w-10 text-gray-700 dark:text-[#333]" />
        <p className="text-sm font-medium text-gray-400 dark:text-[#666]">Select a specific cluster to view this page</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-[#444]">Use the cluster selector in the top bar</p>
      </div>
    );
  }

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
      const res = await fetch(`/api/cluster/nodes/${encodeURIComponent(node.name)}/cordon`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cordon: !node.unschedulable }),
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

  const handleDrainNode = async (node: Node) => {
    if (!isAdmin || !nodePodData) return;
    setDrainingNode(node.name);
    try {
      if (!node.unschedulable) {
        const cordonRes = await fetch(`/api/cluster/nodes/${encodeURIComponent(node.name)}/cordon`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cordon: true }),
        });
        if (!cordonRes.ok) throw new Error("Failed to cordon node before drain");
      }

      const movablePods = (podsByNode[node.name] ?? []).filter(pod => pod.canMigrate).sort((a, b) => b.memoryMi - a.memoryMi);
      const capacityMap = new Map((nodePodData.nodes ?? []).map(entry => [entry.name, { ...entry }]));
      let moved = 0;
      let skipped = 0;

      for (const pod of movablePods) {
        const targets = [...capacityMap.values()]
          .filter(target => target.name !== node.name && target.status === "Ready" && target.availableMi >= pod.memoryMi + 256)
          .sort((a, b) => b.availableMi - a.availableMi);
        const target = targets[0];
        if (!target) {
          skipped += 1;
          continue;
        }
        const res = await fetch("/api/cluster/migrate-pod", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: pod.namespace, podName: pod.name, targetNode: target.name }),
        });
        if (res.ok) {
          moved += 1;
          const current = capacityMap.get(target.name);
          if (current) {
            current.availableMi = Math.max(0, current.availableMi - pod.memoryMi);
            current.usedMi += pod.memoryMi;
          }
        } else {
          skipped += 1;
        }
      }

      toast.success(`Drain queued for ${node.name}: moved ${moved}, skipped ${skipped}`);
      await Promise.all([refetch(), refetchNodePods(), refetchMetrics()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to drain node");
    } finally {
      setDrainingNode(null);
      setDrainTarget(null);
    }
  };

  const handleExportYaml = () => {
    window.location.href = "/api/cluster/export";
  };

  // ── Agent approval ────────────────────────────────────────────────────────
  const [approvingAgent, setApprovingAgent] = useState<string | null>(null);
  const [rejectingAgent, setRejectingAgent] = useState<string | null>(null);

  const { data: agentData, refetch: refetchAgents } = useQuery<{
    agents: Array<{ clusterId: string; connectedAt: string; lastHeartbeat: string; status: { nodeCount: number; podCount: number; ready: boolean } }>;
    pending: Array<{ agentId: string; clusterName: string; clusterCaFingerprint: string; receivedAt: string }>;
  }>({
    queryKey: ["agents"],
    queryFn: () => fetch("/api/agents").then(r => r.json()),
    refetchInterval: 8_000,
  });

  async function approveAgent(agentId: string) {
    setApprovingAgent(agentId);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clusterId: "prod-cluster", clusterName: "Production Cluster", environment: "production" }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Approval failed");
      toast.success("Agent approved — waiting for node to connect");
      await refetchAgents();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovingAgent(null);
    }
  }

  async function rejectAgent(agentId: string) {
    setRejectingAgent(agentId);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Rejected by admin" }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Reject failed");
      toast.success("Agent rejected");
      await refetchAgents();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRejectingAgent(null);
    }
  }
  // ── end agent approval ────────────────────────────────────────────────────

  return (
    <div>
      <PageHeader icon={Server} title="Cluster Nodes" subtitle="Node management and cluster overview" />

      {/* ── Agent status (connected + pending approval) ───────────────────── */}
      {agentData && (agentData.agents.length > 0 || agentData.pending.length > 0) && (
        <div className="mb-4 space-y-3 sm:mb-6">
          {agentData.pending.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                <span className="text-sm font-semibold text-amber-300">
                  {agentData.pending.length} agent{agentData.pending.length !== 1 ? "s" : ""} awaiting approval
                </span>
              </div>
              <div className="space-y-2">
                {agentData.pending.map((agent) => (
                  <div key={agent.agentId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-black/20 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{agent.clusterName}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-gray-400 dark:text-[#666]">{agent.agentId}</p>
                      <p className="text-[11px] text-gray-500 dark:text-[#777]">
                        Connected {new Date(agent.receivedAt).toLocaleTimeString()} · CA {agent.clusterCaFingerprint.slice(0, 16)}…
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => approveAgent(agent.agentId)}
                        disabled={approvingAgent === agent.agentId}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {approvingAgent === agent.agentId ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                        Approve
                      </button>
                      <button
                        onClick={() => rejectAgent(agent.agentId)}
                        disabled={rejectingAgent === agent.agentId}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {rejectingAgent === agent.agentId ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldX className="h-3 w-3" />}
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {agentData.agents.length > 0 && (
            <div className="rounded-xl border border-green-500/20 bg-green-500/5 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Radio className="h-4 w-4 text-green-400" />
                <span className="text-sm font-semibold text-green-300">
                  {agentData.agents.length} agent{agentData.agents.length !== 1 ? "s" : ""} connected
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {agentData.agents.map((agent) => (
                  <div key={agent.clusterId} className="rounded-lg border border-green-500/15 bg-black/20 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-green-400" />
                      <span className="text-sm font-medium text-gray-900 dark:text-white">{agent.clusterId}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-gray-500 dark:text-[#777]">
                      {agent.status.nodeCount} nodes · {agent.status.podCount} pods ·
                      heartbeat {timeAgo(new Date(agent.lastHeartbeat))}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Main cluster content ──────────────────────────────────────────── */}
      <div className="relative mb-4 overflow-hidden rounded-xl sm:mb-6">
        <div className="relative flex flex-wrap items-start justify-between gap-3 p-4 sm:gap-4 sm:p-5">
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
              <Server className="w-5 h-5 text-indigo-400" />
              Cluster Management
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Node status and cluster operations</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Link href="/node-top" className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <Activity className="w-3.5 h-3.5" />
              Node Top
            </Link>
            <Link href="/pipelines" className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <GitBranch className="w-3.5 h-3.5" />
              Pipelines
            </Link>
            <button onClick={handleExportYaml} className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <Download className="w-3.5 h-3.5" />
              Export YAML
            </button>
            <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300">
              <span className="text-xs text-slate-500 dark:text-slate-400">Metrics</span>
              <select
                value={metricsRefreshSeconds}
                onChange={(event) => setMetricsRefreshSeconds(Number(event.target.value))}
                className="bg-transparent text-sm text-gray-900 dark:text-white focus:outline-none"
              >
                {[15, 30, 60].map((seconds) => (
                  <option key={seconds} value={seconds} className="bg-slate-100 dark:bg-slate-900">{seconds}s</option>
                ))}
              </select>
            </div>
            <button onClick={() => { void refetch(); void refetchMetrics(); void refetchHpa(); void refetchNodePods(); void refetchQuota(); void refetchEvents(); void refetchPdbs(); }} className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white active:scale-95 touch-manipulation sm:flex-none">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <DashboardPanel title="Cluster posture" description="Critical node health, resource pressure, and migration capacity before the detailed sections." icon={Server}>
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
            <DashboardStatCard label="Nodes" value={nodes.length} icon={Server} tone="info" description="Total nodes currently registered in the cluster." trendData={cpuHistory.map((point) => ({ label: point.time, value: Math.min(nodes.length, readyNodesCount) }))} trendTone="blue" trendLabel="Cluster node availability trend" footer={<span>{readyNodesCount} ready · {nodes.filter(node => node.unschedulable).length} cordoned</span>} />
            <DashboardStatCard label="CPU pressure" value={`${avgCpu}%`} icon={Activity} tone={avgCpu >= 70 ? "warning" : "success"} description="Average CPU utilization across visible nodes." trendData={cpuHistory.map((point) => ({ label: point.time, value: point.value }))} trendTone={avgCpu >= 70 ? "amber" : "emerald"} trendLabel="Cluster CPU pressure trend" footer={<span>Search filter targets high-pressure nodes too</span>} />
            <DashboardStatCard label="Memory pressure" value={`${avgMem}%`} icon={MemoryStick} tone={avgMem >= 70 ? "warning" : "success"} description="Average memory usage across node metrics." trendData={memHistory.map((point) => ({ label: point.time, value: point.value }))} trendTone={avgMem >= 70 ? "amber" : "emerald"} trendLabel="Cluster memory pressure trend" footer={<span>{totalMigratablePods} migratable pod(s) available</span>} />
            <DashboardStatCard label="Quota hotspots" value={hotQuotas.length} icon={BarChart2} tone={hotQuotas.some(quota => quota.peak >= 85) ? "danger" : "neutral"} description="Namespaces close to quota exhaustion." trendData={memHistory.map((point) => ({ label: point.time, value: hotQuotas.length }))} trendTone={hotQuotas.some(quota => quota.peak >= 85) ? "red" : "slate"} trendLabel="Quota hotspot count trend" footer={<span>{recentEvents.filter(event => event.type === "Warning").length} recent warning event(s)</span>} />
          </div>
          <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Node capacity distribution</p>
                <p className="text-xs text-slate-500">Healthy, cordoned, and high-pressure nodes grouped into one quick view.</p>
              </div>
              <button onClick={() => { void refetch(); void refetchMetrics(); void refetchHpa(); void refetchNodePods(); void refetchQuota(); void refetchEvents(); void refetchPdbs(); }} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-3 py-1.5 text-xs text-gray-500 dark:text-[#9e9e9e] transition hover:text-gray-900 dark:hover:text-white">
                <RefreshCw className="h-3.5 w-3.5" /> Refresh all
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <SegmentedBar
                segments={[
                  { label: "Ready", value: nodes.filter(node => node.status === "Ready" && !node.unschedulable).length, className: "bg-emerald-500" },
                  { label: "Cordoned", value: nodes.filter(node => node.unschedulable).length, className: "bg-amber-500" },
                  { label: "Pressure", value: nodes.filter(node => Math.max(metricsMap[node.name]?.cpuPct ?? 0, metricsMap[node.name]?.memPct ?? 0) >= 70).length, className: "bg-red-500" },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">Search & filters</p>
                  <p className="mt-2 text-sm text-gray-600 dark:text-[#b8b8b8]">Use <span className="text-gray-900 dark:text-white">/</span> to focus the node search. <span className="text-gray-900 dark:text-white">Esc</span> clears filters and closes dialogs.</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">Events in scope</p>
                  <p className="mt-2 text-sm text-gray-600 dark:text-[#b8b8b8]">{recentEvents.length} recent event(s) loaded · {hotQuotas.length} quota hotspot(s) highlighted below.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DashboardPanel>

      <DashboardPanel title="Node search & maintenance" description="Filter the node cards, then toggle maintenance mode or run a smart-drain without leaving the page." icon={Activity}>
        <div className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <ToolbarSearchInput ref={searchRef} value={nodeSearch} onChange={setNodeSearch} placeholder="Search node name, IP, or role…" className="flex-1" />
            <div className="flex flex-wrap gap-2">
              {([
                { value: "all", label: "All nodes" },
                { value: "ready", label: "Ready" },
                { value: "cordoned", label: "Cordoned" },
                { value: "pressure", label: "High pressure" },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  onClick={() => setNodeFilter(option.value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    nodeFilter === option.value
                      ? "border-[#0078D4]/40 bg-[rgba(0,120,212,0.15)] text-[#9dcbff]"
                      : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-white"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500 dark:text-[#888]">
            <span>{filteredNodes.length} of {nodes.length} node(s) shown</span>
            <RefreshCountdown intervalSeconds={metricsRefreshSeconds} resetKey={metricsData?.timestamp ?? metricsRefreshSeconds} />
            <span>{totalMigratablePods} migratable pod(s)</span>
          </div>
        </div>
      </DashboardPanel>

      {cordonedNodes.length > 0 && (
        <div className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium text-amber-200">Maintenance mode active</p>
              <p className="mt-1 text-amber-100/80">{cordonedNodes.map((node) => node.name).join(", ")} {cordonedNodes.length === 1 ? "is" : "are"} currently cordoned and excluded from new scheduling.</p>
            </div>
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-100">{cordonedNodes.length} node{cordonedNodes.length === 1 ? "" : "s"} in maintenance</span>
          </div>
        </div>
      )}

      <div className="space-y-4 sm:space-y-6">
        {isAdmin && (
          <CollapsibleSection
            title="⚙️ Node Hardware Editor"
            storageKey="cluster-node-editor"
            badge={<Settings2 className="w-4 h-4 text-purple-400 flex-shrink-0" />}
            defaultOpen
          >
            <ClusterSettingsPanel embedded />
          </CollapsibleSection>
        )}

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
          count={filteredNodes.length}
          storageKey="cluster-nodes"
          badge={<Server className="w-4 h-4 text-indigo-400 flex-shrink-0" />}
        >
          {isLoading ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {[...Array(3)].map((_, i) => <div key={i} className="h-36 rounded-xl shimmer-bg" />)}
            </div>
          ) : filteredNodes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-5 py-8 text-center">
              <p className="text-sm font-medium text-gray-900 dark:text-white">No nodes match the current filters</p>
              <p className="mt-2 text-sm text-gray-500 dark:text-[#888]">Clear the search or switch filters to inspect the full cluster again.</p>
              <button onClick={() => { setNodeSearch(""); setNodeFilter("all"); }} className="mt-4 rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-3 py-2 text-xs text-gray-600 dark:text-[#b8b8b8] transition hover:text-gray-900 dark:hover:text-white">
                Reset filters
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {displayNodes.map((node, i) => (
                  <motion.div
                    key={node.name}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.08 }}
                    className={cn(
                      "rounded-xl border p-3 transition-transform active:scale-95 touch-manipulation md:p-4",
                      node.status === "Ready" ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5",
                      node.unschedulable && "opacity-75"
                    )}
                  >
                    <div className="mb-3 flex items-center gap-2">
                      <span className={cn("h-2 w-2 flex-shrink-0 rounded-full", node.status === "Ready" ? "bg-green-500" : "bg-red-500")} />
                      <span className="truncate text-sm font-semibold text-gray-900 dark:text-white">{node.name}</span>
                      {node.unschedulable && <span className="rounded bg-orange-500/10 px-1.5 py-0.5 text-xs text-orange-400">Maintenance</span>}
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between gap-2"><span className="text-slate-500">IP</span><span className="flex items-center gap-2 font-mono text-slate-700 dark:text-slate-300"><span>{node.ip}</span><CopyButton text={node.ip} label="IP" className="h-7 px-2 text-[11px]" /></span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Role</span><span className="text-slate-700 dark:text-slate-300">{node.roles.join(", ") || "worker"}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Version</span><span className="font-mono text-slate-700 dark:text-slate-300">{node.version}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">CPU</span><span className="text-slate-700 dark:text-slate-300">{node.cpu} cores {metricsMap[node.name] ? `(${metricsMap[node.name].cpuPct}% used)` : ""}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Memory</span><span className="text-slate-700 dark:text-slate-300">{node.memory} {metricsMap[node.name] ? `(${metricsMap[node.name].memPct}%)` : ""}</span></div>
                      {node.age && <div className="flex justify-between"><span className="text-slate-500">Uptime</span><RelativeTime date={node.age} className="text-slate-700 dark:text-slate-300" /></div>}
                    </div>
                    {nodeHistory[node.name] && (nodeHistory[node.name].cpu.length > 1 || nodeHistory[node.name].memory.length > 1) ? (
                      <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-2 py-2">
                          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            <span>CPU</span>
                            <span>{metricsMap[node.name]?.cpuPct ?? 0}%</span>
                          </div>
                          <MetricSparkline data={nodeHistory[node.name].cpu} color={(metricsMap[node.name]?.cpuPct ?? 0) >= 70 ? "amber" : "emerald"} height={34} className="h-8" ariaLabel={`${node.name} CPU trend`} />
                        </div>
                        <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-2 py-2">
                          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            <span>Memory</span>
                            <span>{metricsMap[node.name]?.memPct ?? 0}%</span>
                          </div>
                          <MetricSparkline data={nodeHistory[node.name].memory} color={(metricsMap[node.name]?.memPct ?? 0) >= 70 ? "amber" : "blue"} height={34} className="h-8" ariaLabel={`${node.name} memory trend`} />
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {isAdmin ? (
                        <>
                          <button
                            onClick={() => setCordonTarget(node)}
                            disabled={cordoningNode === node.name}
                            className={cn(
                              "rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                              node.unschedulable
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15",
                              cordoningNode === node.name && "opacity-60"
                            )}
                          >
                            {cordoningNode === node.name ? "Updating..." : node.unschedulable ? "Disable maintenance" : "Enable maintenance"}
                          </button>
                          <button
                            onClick={() => setDrainTarget(node)}
                            disabled={drainingNode === node.name}
                            className={cn(
                              "rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-500/15",
                              drainingNode === node.name && "opacity-60"
                            )}
                          >
                            {drainingNode === node.name ? "Draining..." : "Smart drain"}
                          </button>
                        </>
                      ) : (
                        <>
                          <button disabled title="Requires cluster:admin permission" className="flex cursor-not-allowed select-none items-center justify-center gap-1.5 rounded-lg border border-gray-700/30 bg-gray-800/20 px-3 py-2 text-xs font-medium text-gray-600 opacity-60">
                            <Lock className="w-3 h-3" />Maintenance
                          </button>
                          <button disabled title="Requires cluster:drain permission" className="flex cursor-not-allowed select-none items-center justify-center gap-1.5 rounded-lg border border-gray-700/30 bg-gray-800/20 px-3 py-2 text-xs font-medium text-gray-600 opacity-60">
                            <Lock className="w-3 h-3" />Smart drain
                          </button>
                        </>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
              {filteredNodes.length > NODE_PAGE_SIZE && (
                <button onClick={() => setShowAllNodes(v => !v)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 py-2 text-xs text-slate-500 dark:text-slate-400 transition-colors hover:bg-white/8 hover:text-gray-900 dark:hover:text-white">
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAllNodes && "rotate-180")} />
                  {showAllNodes ? "Show fewer" : `Show ${filteredNodes.length - NODE_PAGE_SIZE} more node${filteredNodes.length - NODE_PAGE_SIZE !== 1 ? "s" : ""}`}
                </button>
              )}
            </>
          )}
        </CollapsibleSection>

        {pdbs.length > 0 && (
          <CollapsibleSection title="Disruption budgets" count={pdbs.length} storageKey="cluster-pdbs" badge={<AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />}>
            <div className="mb-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">Protected services</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{pdbs.length}</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-[#888]">{protectedPdbs} currently allow at least one voluntary disruption.</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">Zero-disruption budgets</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{blockedPdbs}</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-[#888]">Single-replica platform services are expected here during maintenance windows.</p>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">At-risk budgets</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{pdbsAtRisk}</p>
                <p className="mt-1 text-sm text-gray-500 dark:text-[#888]">Budgets where currentHealthy is below desiredHealthy and disruption safety is already reduced.</p>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">Budget</th>
                    <th className="px-4 py-3 text-left font-medium">Policy</th>
                    <th className="px-4 py-3 text-left font-medium">Selector</th>
                    <th className="px-4 py-3 text-left font-medium">Healthy</th>
                    <th className="px-4 py-3 text-left font-medium">Disruptions</th>
                  </tr>
                </thead>
                <tbody>
                  {pdbs.map((pdb) => {
                    const selector = Object.entries(pdb.selector).map(([key, value]) => `${key}=${value}`).join(", ") || "Selector unavailable";
                    const policy = pdb.minAvailable !== null ? `minAvailable ${pdb.minAvailable}` : pdb.maxUnavailable !== null ? `maxUnavailable ${pdb.maxUnavailable}` : "No policy";
                    const isHealthy = pdb.currentHealthy >= pdb.desiredHealthy;
                    return (
                      <tr key={`${pdb.namespace}/${pdb.name}`} className="border-t border-[#1c1c1c] align-top text-slate-700 dark:text-slate-300">
                        <td className="px-4 py-4">
                          <p className="font-medium text-gray-900 dark:text-white">{pdb.name}</p>
                          <p className="mt-1 text-xs text-slate-500">{pdb.namespace}</p>
                        </td>
                        <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{policy}</td>
                        <td className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">{selector}</td>
                        <td className="px-4 py-4">
                          <span className={cn("rounded-full px-2 py-1 text-xs font-medium", isHealthy ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300")}>{pdb.currentHealthy}/{pdb.expectedPods || pdb.desiredHealthy}</span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={cn("rounded-full px-2 py-1 text-xs font-medium", pdb.disruptionsAllowed > 0 ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300")}>{pdb.disruptionsAllowed} allowed</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>
        )}

        {hpas.length > 0 && (
          <CollapsibleSection title="Horizontal Pod Autoscalers" count={hpas.length} storageKey="cluster-hpa" badge={<Layers className="w-4 h-4 text-violet-400 flex-shrink-0" />}>
            <div className="space-y-2">
              {hpas.map(hpa => (
                <HPARow key={`${hpa.namespace}/${hpa.name}`} hpa={hpa} isAdmin={isAdmin} onSaved={() => { void refetchHpa(); }} />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {(hotQuotas.length > 0 || recentEvents.length > 0) && (
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            {hotQuotas.length > 0 && (
              <DashboardPanel title="Quota hotspots" description="Namespaces approaching their hard limits." icon={BarChart2}>
                <div className="space-y-3">
                  {hotQuotas.map((quota) => (
                    <div key={`${quota.namespace}-${quota.name}`} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-white">{quota.namespace}</p>
                          <p className="text-xs text-gray-400 dark:text-[#666]">{quota.name}</p>
                        </div>
                        <span className={cn("rounded-full px-2 py-1 text-xs font-medium", quota.peak >= 90 ? "bg-red-500/10 text-red-300" : "bg-amber-500/10 text-amber-300")}>{quota.peak}% used</span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {Object.keys(quota.hard).slice(0, 3).map((resource) => {
                          const pct = quotaPct(quota.used[resource] ?? "0", quota.hard[resource]);
                          return (
                            <div key={resource}>
                              <div className="mb-1 flex items-center justify-between text-xs text-gray-500 dark:text-[#888]">
                                <span>{resource}</span>
                                <span>{quota.used[resource] ?? "0"} / {quota.hard[resource]}</span>
                              </div>
                              <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                                <div className={cn("h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, pct)}%` }} />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </DashboardPanel>
            )}
            {recentEvents.length > 0 && (
              <DashboardPanel title="Recent cluster events" description="Warnings and scheduling activity pulled from the shared event stream." icon={Bell}>
                <div className="space-y-3">
                  {recentEvents.map((event) => (
                    <div key={`${event.namespace}-${event.name}-${event.lastTimestamp}`} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 dark:text-white">{event.reason}</p>
                          <p className="mt-1 text-xs text-gray-500 dark:text-[#888]">{event.namespace} · {event.involvedObject.kind}/{event.involvedObject.name}</p>
                        </div>
                        <span className={cn("rounded-full px-2 py-1 text-[11px] font-medium", event.type === "Warning" ? "bg-red-500/10 text-red-300" : "bg-emerald-500/10 text-emerald-300")}>{event.type}</span>
                      </div>
                      <p className="mt-2 text-sm text-gray-600 dark:text-[#b8b8b8]">{event.message}</p>
                      <p className="mt-2 text-xs text-gray-400 dark:text-[#666]">Last seen {timeAgo(event.lastTimestamp ?? new Date())}</p>
                    </div>
                  ))}
                </div>
              </DashboardPanel>
            )}
          </div>
        )}

        {/* Pod Migration — visible to all, but Move button only for admins */}
        {(nodePodData?.nodes?.length ?? 0) > 0 && (
          <CollapsibleSection
            title="Pod Migration"
            storageKey="cluster-pod-migration"
            badge={<ArrowRightLeft className="w-4 h-4 text-cyan-400 flex-shrink-0" />}
            count={(nodePodData?.pods ?? []).filter(p => p.canMigrate).length}
          >
            <p className="text-xs text-slate-500 mb-3">
              Move workloads between nodes. RAM is validated before migration — moves that would exceed node capacity are blocked.
              Kubernetes re-schedules the pod on the target node; Longhorn storage follows automatically.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {(nodePodData?.nodes ?? []).sort((a, b) => a.name.localeCompare(b.name)).map(nodeCapacity => (
                <NodePodSection
                  key={nodeCapacity.name}
                  nodeCapacity={nodeCapacity}
                  pods={(podsByNode[nodeCapacity.name] ?? []).sort((a, b) => b.memoryMi - a.memoryMi)}
                  allNodes={nodePodData?.nodes ?? []}
                  isAdmin={isAdmin}
                  onMigrated={() => { void refetchNodePods(); void refetchMetrics(); }}
                />
              ))}
            </div>
          </CollapsibleSection>
        )}

        {isAdmin && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 sm:p-5">
            <h3 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">Quick Cluster Actions</h3>
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
              <Link href="/config" className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-2.5 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white sm:w-auto">
                <Link2 className="w-4 h-4" />
                Platform YAML Editor
              </Link>
            </div>
          </motion.div>
        )}

        {showAddNode && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75" onClick={() => setShowAddNode(false)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-slate-100 dark:bg-slate-900 border border-gray-200 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden">
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mt-3" />
              <div className="p-5">
                <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-1">Add New Talos Node</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">Follow these steps to add a new control-plane node</p>
                <div className="mb-3">
                  <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">New Node IP Address</label>
                  <input value={newIp} onChange={e => setNewIp(e.target.value)} className="w-full bg-slate-100 dark:bg-slate-800 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm font-mono text-gray-900 dark:text-white focus:outline-none focus:border-indigo-500/50" placeholder="10.10.0.93" />
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
                        <p className="text-sm text-slate-800 dark:text-slate-200 mb-1">{s.label}</p>
                        {s.cmd && <CodeBlock code={s.cmd} />}
                        {s.note && <p className="text-xs text-slate-500 mt-1">{s.note}</p>}
                      </div>
                    </div>
                  ))}
                </div>
                <button onClick={() => setShowAddNode(false)} className="mt-5 w-full py-2.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors">Close</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </div>

      <ConfirmDialog open={showSyncConfirm} onConfirm={handleSyncAll} onCancel={() => setShowSyncConfirm(false)} title="Sync All ArgoCD Apps?" description="This will trigger a sync for all ArgoCD applications." confirmText="Sync All" />
      <ConfirmDialog open={showRolloutConfirm} onConfirm={handleRollout} onCancel={() => setShowRolloutConfirm(false)} title="Force Redeploy InfraWeaver?" description="This will restart all InfraWeaver console pods. The console will be briefly unavailable." confirmText="REDEPLOY" danger requireTyping="REDEPLOY" />
      <ConfirmDialog
        open={Boolean(cordonTarget)}
        onConfirm={() => cordonTarget && void handleToggleCordon(cordonTarget)}
        onCancel={() => setCordonTarget(null)}
        title={cordonTarget ? `${cordonTarget.unschedulable ? "Disable" : "Enable"} maintenance for ${cordonTarget.name}?` : "Update node maintenance?"}
        description={cordonTarget?.unschedulable
          ? "This makes the node schedulable again so Kubernetes can place new workloads on it."
          : "This cordons the node so new workloads are not scheduled while maintenance is in progress."}
        confirmText={cordoningNode ? "Updating..." : cordonTarget?.unschedulable ? "Disable maintenance" : "Enable maintenance"}
        danger={!cordonTarget?.unschedulable}
      />
      <ConfirmDialog
        open={Boolean(drainTarget)}
        onConfirm={() => drainTarget && void handleDrainNode(drainTarget)}
        onCancel={() => setDrainTarget(null)}
        title={drainTarget ? `Smart drain ${drainTarget.name}?` : "Smart drain node?"}
        description="This cordons the node if needed, then migrates eligible pods to the healthiest destination with available memory headroom."
        confirmText={drainingNode ? "Draining..." : "Drain node"}
        danger
      />
    </div>
  );
}
