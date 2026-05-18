"use client";
import { CheckCircle2, AlertTriangle, WifiOff, HelpCircle, Server, Box } from "lucide-react";
import { type ClusterInfo, useCluster } from "@/contexts/cluster-context";
import { useQuery } from "@tanstack/react-query";

function StatusIcon({ status }: { status: ClusterInfo["status"] }) {
  if (status === "healthy") return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle className="h-4 w-4 text-amber-400" />;
  if (status === "offline") return <WifiOff className="h-4 w-4 text-red-400" />;
  return <HelpCircle className="h-4 w-4 text-gray-400 dark:text-[#555]" />;
}

interface ClusterStats {
  apps: { total: number; healthy: number } | null;
  pods: { total: number; running: number } | null;
}

function useClusterStats(clusterId: string): { data: ClusterStats | null; isLoading: boolean } {
  const appsQuery = useQuery({
    queryKey: ["clusters", clusterId, "apps-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/argocd/apps?clusterId=${encodeURIComponent(clusterId)}`);
      if (!res.ok) return null;
      const list = await res.json() as Array<{ status: { health: { status: string } } }>;
      return {
        total: list.length,
        healthy: list.filter((a) => a.status.health.status === "Healthy").length,
      };
    },
    staleTime: 60_000,
    retry: false,
  });

  const podsQuery = useQuery({
    queryKey: ["clusters", clusterId, "pods-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/pods?clusterId=${encodeURIComponent(clusterId)}`);
      if (!res.ok) return null;
      const list = await res.json() as Array<{ status: string }>;
      return {
        total: list.length,
        running: list.filter((p) => p.status === "Running").length,
      };
    },
    staleTime: 60_000,
    retry: false,
  });

  return {
    data: {
      apps: appsQuery.data ?? null,
      pods: podsQuery.data ?? null,
    },
    isLoading: appsQuery.isLoading || podsQuery.isLoading,
  };
}

export function ClusterSummaryCard({ cluster }: { cluster: ClusterInfo }) {
  const { setActiveId } = useCluster();
  const { data: stats, isLoading: statsLoading } = useClusterStats(cluster.id);

  return (
    <button
      onClick={() => setActiveId(cluster.id)}
      className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 text-left transition-all hover:border-[#3b82f6]/40 hover:bg-gray-100 dark:hover:bg-[#161616] active:scale-[0.98]"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white dark:bg-[#1a1a1a]">
            <Server className="h-4 w-4 text-[#60a5fa]" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{cluster.name}</p>
            <p className="text-[10px] text-gray-400 dark:text-[#555]">{cluster.description}</p>
          </div>
        </div>
        <StatusIcon status={cluster.status} />
      </div>

      {/* Per-cluster stats */}
      {cluster.status !== "offline" && (
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3 text-emerald-400/60" />
            {statsLoading ? (
              <span className="text-[11px] text-gray-400 dark:text-[#555]">…</span>
            ) : stats?.apps ? (
              <span className="text-[11px] text-gray-500 dark:text-[#888]">{stats.apps.healthy}/{stats.apps.total} apps</span>
            ) : (
              <span className="text-[11px] text-gray-400 dark:text-[#444]">apps n/a</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Box className="h-3 w-3 text-[#60a5fa]/60" />
            {statsLoading ? (
              <span className="text-[11px] text-gray-400 dark:text-[#555]">…</span>
            ) : stats?.pods ? (
              <span className="text-[11px] text-gray-500 dark:text-[#888]">{stats.pods.running}/{stats.pods.total} pods</span>
            ) : (
              <span className="text-[11px] text-gray-400 dark:text-[#444]">pods n/a</span>
            )}
          </div>
        </div>
      )}

      {cluster.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cluster.tags.map(tag => (
            <span key={tag} className="rounded-full bg-gray-100 dark:bg-[#2a2a2a] px-2 py-0.5 text-[10px] text-gray-400 dark:text-[#666]">{tag}</span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-[#3b82f6]">Click to manage →</p>
    </button>
  );
}
