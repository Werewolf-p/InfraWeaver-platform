"use client";
import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { toast } from "@/lib/notify";
import { Trash2 } from "lucide-react";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { SortableHeader } from "@/components/ui/sortable-header";
import { useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

interface Pod {
  name: string;
  namespace: string;
  status: string;
}

interface NsStats {
  namespace: string;
  running: number;
  pending: number;
  failed: number;
  completed: number;
  total: number;
}

type SortKey = "namespace" | "running" | "pending" | "failed" | "total";

export default function NamespaceCleanupPage() {
  const { can } = useRBAC();
  const canManageNamespaces = can("cluster:admin");
  const [preview, setPreview] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("failed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: podsData, isLoading } = useApiQuery<Pod[]>({
    queryKey: ["pods"],
    path: "/api/pods",
  });

  const pods = useMemo(() => podsData ?? [], [podsData]);
  const stats = useMemo(() => {
    const byNs: Record<string, NsStats> = {};
    for (const pod of pods) {
      if (!byNs[pod.namespace]) byNs[pod.namespace] = { namespace: pod.namespace, running: 0, pending: 0, failed: 0, completed: 0, total: 0 };
      const s = pod.status.toLowerCase();
      byNs[pod.namespace].total++;
      if (s === "running") byNs[pod.namespace].running++;
      else if (s === "pending") byNs[pod.namespace].pending++;
      else if (s === "failed") byNs[pod.namespace].failed++;
      else if (s === "completed" || s === "succeeded") byNs[pod.namespace].completed++;
    }
    return Object.values(byNs);
  }, [pods]);

  const candidateSet = useMemo(() => new Set(preview ?? []), [preview]);
  const totalFailed = useMemo(() => stats.reduce((sum, s) => sum + s.failed, 0), [stats]);

  const visibleStats = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query ? stats.filter((s) => s.namespace.toLowerCase().includes(query)) : stats;
    const direction = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "namespace") return direction * a.namespace.localeCompare(b.namespace);
      return direction * (a[sortKey] - b[sortKey]);
    });
  }, [stats, search, sortKey, sortDir]);

  const handleSort = (key: string) => {
    const nextKey = key as SortKey;
    if (nextKey === sortKey) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(nextKey);
      setSortDir(nextKey === "namespace" ? "asc" : "desc");
    }
  };

  const handlePreview = async () => {
    if (!canManageNamespaces) {
      toast.error("You do not have permission to preview namespace cleanup");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/cluster/namespace-cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true }) });
      const data = await res.json() as { namespaces?: string[] };
      setPreview(data.namespaces ?? []);
      toast.success("Preview loaded");
    } catch {
      toast.error("Failed to preview cleanup");
    } finally {
      setLoading(false);
    }
  };

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Trash2} title="Namespace Cleanup" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Namespace Cleanup</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Identify namespaces with failed/stale pods</p>
        </div>
        <button onClick={handlePreview} disabled={loading || !canManageNamespaces} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-sm text-red-500 dark:text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-50">
          <Trash2 className="w-4 h-4" />
          {loading ? "Loading..." : "Preview Cleanup"}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <DashboardStatCard label="Namespaces" value={stats.length} description="Namespaces with pods" />
        <DashboardStatCard label="Failed pods" value={totalFailed} tone={totalFailed > 0 ? "danger" : "success"} description="Across all namespaces" />
        <DashboardStatCard
          label="Cleanup candidates"
          value={preview === null ? "—" : candidateSet.size}
          tone={candidateSet.size > 0 ? "warning" : "neutral"}
          description={preview === null ? "Run Preview to detect" : "Flagged by the last preview"}
        />
      </div>

      {preview !== null && (
        <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Cleanup Candidates</h3>
          {candidateSet.size === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No namespaces need cleanup</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {[...candidateSet].map(ns => (
                <span key={ns} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-500 dark:text-red-300">
                  <Trash2 className="w-3.5 h-3.5" />
                  {ns}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search namespaces…" className="sm:max-w-md" />

      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
                  <SortableHeader label="Namespace" sortKey="namespace" activeKey={sortKey} direction={sortDir} onSort={handleSort} />
                </th>
                {(["running", "pending", "failed", "total"] as const).map((key) => (
                  <th key={key} className="px-4 py-3 text-right text-xs font-semibold">
                    <SortableHeader
                      label={key.charAt(0).toUpperCase() + key.slice(1)}
                      sortKey={key}
                      activeKey={sortKey}
                      direction={sortDir}
                      onSort={handleSort}
                      className={cn(
                        "ml-auto",
                        key === "running" && "text-green-600 dark:text-green-400",
                        key === "pending" && "text-yellow-600 dark:text-yellow-400",
                        key === "failed" && "text-red-600 dark:text-red-400",
                        key === "total" && "text-slate-500 dark:text-slate-400",
                      )}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleStats.map(s => {
                const isCandidate = candidateSet.has(s.namespace);
                return (
                  <tr key={s.namespace} className={cn("border-b border-gray-200 dark:border-white/5 transition-colors hover:bg-gray-100 dark:hover:bg-white/5", isCandidate && "bg-red-500/5")}>
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">
                      <span className="flex items-center gap-2">
                        {s.namespace}
                        {isCandidate && <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-300">Candidate</span>}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{s.running}</td>
                    <td className="px-4 py-3 text-sm text-right text-yellow-600 dark:text-yellow-400">{s.pending}</td>
                    <td className={cn("px-4 py-3 text-sm text-right", s.failed > 0 ? "font-semibold text-red-600 dark:text-red-400" : "text-slate-500")}>{s.failed}</td>
                    <td className="px-4 py-3 text-sm text-right text-slate-700 dark:text-slate-300">{s.total}</td>
                  </tr>
                );
              })}
              {visibleStats.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-slate-500">No namespaces match your search.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </motion.div>
  );
}
