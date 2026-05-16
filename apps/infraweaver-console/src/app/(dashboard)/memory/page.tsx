"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, MemoryStick, RefreshCw } from "lucide-react";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface NamespaceBreakdown {
  name: string;
  total_request_mib: number;
  total_limit_mib: number;
  pod_count: number;
}

interface MemoryHeatmapResponse {
  namespaces: NamespaceBreakdown[];
}

interface CpuConsumer {
  pod: string;
  namespace: string;
  node: string;
  cpu_cores: number;
  cpu_pct: number;
}

interface MemoryConsumer {
  pod: string;
  namespace: string;
  node: string;
  memory_mib: number;
  memory_pct: number;
}

interface TopConsumersResponse {
  cpu: CpuConsumer[];
  memory: MemoryConsumer[];
}

function formatGiB(valueMiB: number) {
  return `${(valueMiB / 1024).toFixed(valueMiB >= 1024 ? 1 : 2)} GiB`;
}

function pressurePct(namespace: NamespaceBreakdown, maxRequestMiB: number) {
  if (namespace.total_limit_mib > 0) {
    return Math.round((namespace.total_request_mib / namespace.total_limit_mib) * 100);
  }
  if (!maxRequestMiB) return 0;
  return Math.round((namespace.total_request_mib / maxRequestMiB) * 100);
}

function pressureStyles(pct: number) {
  if (pct >= 85) {
    return {
      row: "bg-red-500/10 border-red-500/20 hover:bg-red-500/15",
      accent: "text-red-300",
      badgeStatus: "failed",
      badgeLabel: "Hot",
    } as const;
  }
  if (pct >= 60) {
    return {
      row: "bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15",
      accent: "text-amber-200",
      badgeStatus: "warning",
      badgeLabel: "Watch",
    } as const;
  }
  return {
    row: "bg-emerald-500/10 border-emerald-500/20 hover:bg-emerald-500/15",
    accent: "text-emerald-200",
    badgeStatus: "healthy",
    badgeLabel: "Healthy",
  } as const;
}

function SectionTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-12 rounded-2xl bg-slate-100/70 animate-pulse dark:bg-white/5" />
      ))}
    </div>
  );
}

export default function MemoryPage() {
  const [search, setSearch] = useState("");

  const heatmapQuery = useQuery<MemoryHeatmapResponse>({
    queryKey: queryKeys.cluster.memoryHeatmap(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/memory-heatmap");
      if (!response.ok) throw new Error("Failed to load namespace memory data");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return response.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const topConsumersQuery = useQuery<TopConsumersResponse>({
    queryKey: queryKeys.cluster.topConsumers(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/top-consumers");
      if (!response.ok) throw new Error("Failed to load top consumers");
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return response.json();
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const namespaces = heatmapQuery.data?.namespaces ?? [];
  const cpuConsumers: CpuConsumer[] = topConsumersQuery.data?.cpu ?? [];
  const memoryConsumers: MemoryConsumer[] = topConsumersQuery.data?.memory ?? [];
  const maxRequestMiB = useMemo(
    () => namespaces.reduce((max, namespace) => Math.max(max, namespace.total_request_mib), 0),
    [namespaces],
  );

  const filteredNamespaces = useMemo(() => {
    const query = search.trim().toLowerCase();
    return namespaces.filter((namespace) => !query || namespace.name.toLowerCase().includes(query));
  }, [namespaces, search]);

  const totalRequestMiB = namespaces.reduce((sum, namespace) => sum + namespace.total_request_mib, 0);
  const totalLimitMiB = namespaces.reduce((sum, namespace) => sum + namespace.total_limit_mib, 0);
  const hotNamespaces = namespaces.filter((namespace) => pressurePct(namespace, maxRequestMiB) >= 85).length;
  const topMemoryPod = memoryConsumers[0];
  const lastUpdatedAt = Math.max(heatmapQuery.dataUpdatedAt, topConsumersQuery.dataUpdatedAt);

  const refreshAll = () => {
    void Promise.all([heatmapQuery.refetch(), topConsumersQuery.refetch()]);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={MemoryStick}
        title="Memory Heatmap"
        description={`Namespace memory reservations and live top consumers${lastUpdatedAt ? ` · updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ""}`}
        actions={(
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-slate-200 bg-white/95 px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2] dark:hover:bg-[#151515]"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        )}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <DashboardStatCard
          label="Namespaces"
          value={namespaces.length}
          icon={MemoryStick}
          tone="info"
          description="Unique namespaces with active pod specs contributing to memory reservations."
        />
        <DashboardStatCard
          label="Requested memory"
          value={formatGiB(totalRequestMiB)}
          icon={Activity}
          tone={hotNamespaces > 0 ? "warning" : "success"}
          description="Aggregated pod memory requests from namespace specs."
        />
        <DashboardStatCard
          label="Defined limits"
          value={formatGiB(totalLimitMiB)}
          icon={Cpu}
          tone="neutral"
          description="Total namespace memory limits currently declared across pods."
        />
        <DashboardStatCard
          label="Largest live pod"
          value={topMemoryPod ? `${topMemoryPod.memory_mib.toFixed(0)} MiB` : "—"}
          icon={MemoryStick}
          tone={topMemoryPod && topMemoryPod.memory_pct >= 85 ? "danger" : "neutral"}
          description={topMemoryPod ? `${topMemoryPod.namespace}/${topMemoryPod.pod}` : "Waiting for metrics-server data."}
        />
      </div>

      <DashboardPanel
        title="Namespace memory heatmap"
        description="Color-coded namespace rows show requested-to-limited memory pressure. Namespaces without limits are shaded relative to the largest requester."
        icon={MemoryStick}
        actions={<div className="w-full md:w-72"><ToolbarSearchInput value={search} onChange={setSearch} placeholder="Filter namespaces…" /></div>}
      >
        {heatmapQuery.isLoading && namespaces.length === 0 ? (
          <SectionTableSkeleton />
        ) : heatmapQuery.isError ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">Unable to load memory heatmap data right now.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full border-separate border-spacing-y-2">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-[#888]">
                  <th className="px-4 py-2">Namespace</th>
                  <th className="px-4 py-2 text-right">Pods</th>
                  <th className="px-4 py-2 text-right">Requests</th>
                  <th className="px-4 py-2 text-right">Limits</th>
                  <th className="px-4 py-2 text-right">Headroom</th>
                  <th className="px-4 py-2 text-right">Pressure</th>
                </tr>
              </thead>
              <tbody>
                {filteredNamespaces.map((namespace) => {
                  const pct = pressurePct(namespace, maxRequestMiB);
                  const styles = pressureStyles(pct);
                  const headroomMiB = Math.max(namespace.total_limit_mib - namespace.total_request_mib, 0);
                  return (
                    <tr key={namespace.name} className={cn("rounded-2xl border transition-colors", styles.row)}>
                      <td className="rounded-l-2xl px-4 py-3 align-middle">
                        <div className="flex items-center gap-3">
                          <div className="h-3 w-3 rounded-full bg-current opacity-70" aria-hidden="true" />
                          <div>
                            <p className="font-medium text-slate-950 dark:text-[#f2f2f2]">{namespace.name}</p>
                            <p className="text-xs text-slate-500 dark:text-[#888]">{namespace.total_limit_mib > 0 ? "Requests vs declared limit" : "No memory limit declared"}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-slate-700 dark:text-[#d4d4d4]">{namespace.pod_count}</td>
                      <td className={cn("px-4 py-3 text-right text-sm font-semibold", styles.accent)}>{namespace.total_request_mib.toFixed(1)} MiB</td>
                      <td className="px-4 py-3 text-right text-sm text-slate-700 dark:text-[#d4d4d4]">{namespace.total_limit_mib > 0 ? `${namespace.total_limit_mib.toFixed(1)} MiB` : "—"}</td>
                      <td className="px-4 py-3 text-right text-sm text-slate-700 dark:text-[#d4d4d4]">{namespace.total_limit_mib > 0 ? `${headroomMiB.toFixed(1)} MiB` : "—"}</td>
                      <td className="rounded-r-2xl px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-2">
                          <span className="text-sm font-semibold text-slate-700 dark:text-[#d4d4d4]">{pct}%</span>
                          <StatusBadge status={styles.badgeStatus} label={styles.badgeLabel} size="sm" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredNamespaces.length === 0 ? (
              <div className="py-10 text-center text-sm text-slate-500 dark:text-[#888]">No namespaces match the current filter.</div>
            ) : null}
          </div>
        )}
      </DashboardPanel>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <DashboardPanel
          title="Top CPU consumers"
          description="Live pod CPU cores from metrics-server, normalized as a share of the hosting node."
          icon={Cpu}
        >
          {topConsumersQuery.isLoading && !cpuConsumers.length ? (
            <SectionTableSkeleton rows={5} />
          ) : topConsumersQuery.isError ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">Unable to load CPU consumers.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-slate-200/80 text-left text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:border-white/5 dark:text-[#888]">
                    <th className="px-3 py-3">Pod</th>
                    <th className="px-3 py-3">Namespace</th>
                    <th className="px-3 py-3">Node</th>
                    <th className="px-3 py-3 text-right">Cores</th>
                    <th className="px-3 py-3 text-right">Node %</th>
                  </tr>
                </thead>
                <tbody>
                  {cpuConsumers.map((row) => (
                    <tr key={`${row.namespace}/${row.pod}`} className="border-b border-slate-200/70 text-sm hover:bg-slate-50/80 dark:border-white/5 dark:hover:bg-white/[0.03]">
                      <td className="px-3 py-3 font-medium text-slate-950 dark:text-[#f2f2f2]">{row.pod}</td>
                      <td className="px-3 py-3 text-slate-600 dark:text-[#b8b8b8]">{row.namespace}</td>
                      <td className="px-3 py-3 text-slate-600 dark:text-[#b8b8b8]">{row.node || "—"}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-700 dark:text-[#d4d4d4]">{row.cpu_cores.toFixed(3)}</td>
                      <td className="px-3 py-3 text-right">
                        <StatusBadge status={row.cpu_pct >= 85 ? "failed" : row.cpu_pct >= 60 ? "warning" : "healthy"} label={`${row.cpu_pct.toFixed(1)}%`} size="sm" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Top memory consumers"
          description="Live pod working set memory from metrics-server, ranked against node allocatable memory."
          icon={Activity}
        >
          {topConsumersQuery.isLoading && !memoryConsumers.length ? (
            <SectionTableSkeleton rows={5} />
          ) : topConsumersQuery.isError ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">Unable to load memory consumers.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="border-b border-slate-200/80 text-left text-xs font-semibold uppercase tracking-[0.18em] text-slate-500 dark:border-white/5 dark:text-[#888]">
                    <th className="px-3 py-3">Pod</th>
                    <th className="px-3 py-3">Namespace</th>
                    <th className="px-3 py-3">Node</th>
                    <th className="px-3 py-3 text-right">Memory</th>
                    <th className="px-3 py-3 text-right">Node %</th>
                  </tr>
                </thead>
                <tbody>
                  {memoryConsumers.map((row) => (
                    <tr key={`${row.namespace}/${row.pod}`} className="border-b border-slate-200/70 text-sm hover:bg-slate-50/80 dark:border-white/5 dark:hover:bg-white/[0.03]">
                      <td className="px-3 py-3 font-medium text-slate-950 dark:text-[#f2f2f2]">{row.pod}</td>
                      <td className="px-3 py-3 text-slate-600 dark:text-[#b8b8b8]">{row.namespace}</td>
                      <td className="px-3 py-3 text-slate-600 dark:text-[#b8b8b8]">{row.node || "—"}</td>
                      <td className="px-3 py-3 text-right font-mono text-slate-700 dark:text-[#d4d4d4]">{row.memory_mib.toFixed(1)} MiB</td>
                      <td className="px-3 py-3 text-right">
                        <StatusBadge status={row.memory_pct >= 85 ? "failed" : row.memory_pct >= 60 ? "warning" : "healthy"} label={`${row.memory_pct.toFixed(1)}%`} size="sm" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardPanel>
      </div>
    </div>
  );
}
