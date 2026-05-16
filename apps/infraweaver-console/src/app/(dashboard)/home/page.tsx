"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  GitBranch,
  Package,
  RefreshCw,
  Server,
} from "lucide-react";
import { PageShell } from "@/components/layout/page-shell";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { MetricCard } from "@/components/ui/metric-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn, timeAgo } from "@/lib/utils";
import type { ClusterEventPayload } from "@/lib/ops-data";
import type { ArgoApp } from "@/types";

interface ClusterHealthResponse {
  degraded: number;
  healthy: number;
  outOfSync: number;
  progressing: number;
  status: "healthy" | "degraded" | "progressing" | "unknown";
  total: number;
}

interface ClusterNode {
  age: string | null;
  cpu: string | undefined;
  ip: string | undefined;
  memory: string | undefined;
  name: string | undefined;
  os: string | undefined;
  roles: string[];
  status: string;
  unschedulable: boolean;
  version: string | undefined;
}

interface NodesResponse {
  nodes: ClusterNode[];
}

interface PodItem {
  containers: string[];
  createdAt: string;
  name: string;
  namespace: string;
  nodeName: string;
  restartCount: number;
  status: string;
}

interface TopConsumersResponse {
  cpu: Array<{
    cpu_cores: number;
    cpu_pct: number;
    namespace: string;
    node: string;
    pod: string;
  }>;
  memory: Array<{
    memory_mib: number;
    memory_pct: number;
    namespace: string;
    node: string;
    pod: string;
  }>;
}

interface AppUsageRow {
  id: string;
  name: string;
  namespace: string;
  health: string;
  syncStatus: string;
  cpuCores: number;
  memoryMiB: number;
  podCount: number;
  restarts: number;
  hotPod: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}`);
  }
  return response.json() as Promise<T>;
}

function getMetricDirection(isHealthy: boolean, isWarning = false): "up" | "down" | "flat" {
  if (isWarning) return "down";
  return isHealthy ? "up" : "flat";
}

export default function HomePage() {
  const clusterQuery = useQuery<ClusterHealthResponse>({
    queryKey: ["home", "cluster-health"],
    queryFn: () => fetchJson<ClusterHealthResponse>("/api/health/cluster"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const appsQuery = useQuery<ArgoApp[]>({
    queryKey: ["home", "apps"],
    queryFn: () => fetchJson<ArgoApp[]>("/api/apps"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const nodesQuery = useQuery<NodesResponse>({
    queryKey: ["home", "nodes"],
    queryFn: () => fetchJson<NodesResponse>("/api/cluster/nodes"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const podsQuery = useQuery<PodItem[]>({
    queryKey: ["home", "pods"],
    queryFn: () => fetchJson<PodItem[]>("/api/pods"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const eventsQuery = useQuery<ClusterEventPayload>({
    queryKey: ["home", "events"],
    queryFn: () => fetchJson<ClusterEventPayload>("/api/cluster/events"),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
  const consumersQuery = useQuery<TopConsumersResponse>({
    queryKey: ["home", "top-consumers"],
    queryFn: () => fetchJson<TopConsumersResponse>("/api/cluster/top-consumers"),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  const apps = useMemo(() => appsQuery.data ?? [], [appsQuery.data]);
  const nodes = useMemo(() => nodesQuery.data?.nodes ?? [], [nodesQuery.data?.nodes]);
  const pods = useMemo(() => podsQuery.data ?? [], [podsQuery.data]);
  const events = useMemo(() => eventsQuery.data?.events ?? [], [eventsQuery.data?.events]);

  const readyNodes = nodes.filter((node) => node.status === "Ready").length;
  const runningPods = pods.filter((pod) => pod.status === "Running").length;
  const restartingPods = pods.filter((pod) => pod.restartCount > 0).length;
  const healthyApps = apps.filter((app) => app.status.health.status === "Healthy").length;
  const degradedApps = apps.filter((app) => app.status.health.status === "Degraded").length;
  const syncedApps = apps.filter((app) => app.status.sync.status === "Synced").length;
  const outOfSyncApps = apps.filter((app) => app.status.sync.status === "OutOfSync").length;

  const nodeHealthPercent = nodes.length ? Math.round((readyNodes / nodes.length) * 100) : 0;
  const podHealthPercent = pods.length ? Math.round((runningPods / pods.length) * 100) : 0;
  const appHealthPercent = apps.length ? Math.round((healthyApps / apps.length) * 100) : 0;
  const syncPercent = apps.length ? Math.round((syncedApps / apps.length) * 100) : 0;

  const metricCards = [
    {
      title: "Ready nodes",
      value: readyNodes,
      unit: `/ ${nodes.length || 0}`,
      href: "/cluster",
      variant: nodeHealthPercent === 100 ? "success" : nodeHealthPercent > 0 ? "warning" : "danger",
      trend: { direction: getMetricDirection(nodeHealthPercent === 100, nodeHealthPercent < 100 && nodes.length > 0), percent: nodeHealthPercent },
      sparklineData: nodes.map((node) => ({ value: node.status === "Ready" ? 100 : 35 })),
      loading: nodesQuery.isLoading,
    },
    {
      title: "Healthy apps",
      value: healthyApps,
      unit: `/ ${apps.length || 0}`,
      href: "/apps",
      variant: degradedApps > 0 ? "warning" : "success",
      trend: { direction: getMetricDirection(degradedApps === 0, degradedApps > 0), percent: appHealthPercent },
      sparklineData: [healthyApps, degradedApps, outOfSyncApps || healthyApps, apps.length || healthyApps].map((value) => ({ value })),
      loading: appsQuery.isLoading,
    },
    {
      title: "Running pods",
      value: runningPods,
      unit: `/ ${pods.length || 0}`,
      href: "/pods",
      variant: podHealthPercent === 100 ? "success" : restartingPods > 0 ? "warning" : "default",
      trend: { direction: getMetricDirection(podHealthPercent === 100, podHealthPercent < 100 && pods.length > 0), percent: podHealthPercent },
      sparklineData: pods.slice(0, 12).map((pod) => ({ value: pod.status === "Running" ? 100 : Math.max(20, 100 - pod.restartCount * 8) })),
      loading: podsQuery.isLoading,
    },
    {
      title: "Sync compliance",
      value: syncPercent,
      unit: "% synced",
      href: "/apps",
      variant: outOfSyncApps > 0 ? "danger" : "success",
      trend: { direction: getMetricDirection(outOfSyncApps === 0, outOfSyncApps > 0), percent: syncPercent },
      sparklineData: [syncedApps, healthyApps, outOfSyncApps, apps.length].map((value) => ({ value })),
      loading: appsQuery.isLoading,
    },
  ] as const;

  const usageRows = useMemo<AppUsageRow[]>(() => {
    const namespaceToApp = new Map<string, ArgoApp>();
    for (const app of apps) {
      const namespace = app.spec.destination.namespace || app.metadata.namespace;
      if (namespace && !namespaceToApp.has(namespace)) {
        namespaceToApp.set(namespace, app);
      }
    }

    const podUsage = new Map<string, { namespace: string; pod: string; cpuCores: number; memoryMiB: number }>();
    for (const consumer of consumersQuery.data?.cpu ?? []) {
      const key = `${consumer.namespace}/${consumer.pod}`;
      podUsage.set(key, {
        namespace: consumer.namespace,
        pod: consumer.pod,
        cpuCores: consumer.cpu_cores,
        memoryMiB: podUsage.get(key)?.memoryMiB ?? 0,
      });
    }
    for (const consumer of consumersQuery.data?.memory ?? []) {
      const key = `${consumer.namespace}/${consumer.pod}`;
      podUsage.set(key, {
        namespace: consumer.namespace,
        pod: consumer.pod,
        cpuCores: podUsage.get(key)?.cpuCores ?? 0,
        memoryMiB: consumer.memory_mib,
      });
    }

    const podCounts = new Map<string, { count: number; restarts: number }>();
    for (const pod of pods) {
      const current = podCounts.get(pod.namespace) ?? { count: 0, restarts: 0 };
      current.count += 1;
      current.restarts += pod.restartCount;
      podCounts.set(pod.namespace, current);
    }

    const grouped = new Map<string, AppUsageRow>();
    for (const entry of podUsage.values()) {
      const app = namespaceToApp.get(entry.namespace);
      const id = app?.metadata.name ?? entry.namespace;
      const current = grouped.get(id) ?? {
        id,
        name: app?.metadata.name ?? entry.namespace,
        namespace: entry.namespace,
        health: app?.status.health.status ?? "Unknown",
        syncStatus: app?.status.sync.status ?? "Unknown",
        cpuCores: 0,
        memoryMiB: 0,
        podCount: podCounts.get(entry.namespace)?.count ?? 0,
        restarts: podCounts.get(entry.namespace)?.restarts ?? 0,
        hotPod: entry.pod,
      };
      current.cpuCores += entry.cpuCores;
      current.memoryMiB += entry.memoryMiB;
      if ((entry.cpuCores * 1000) + entry.memoryMiB > ((current.cpuCores * 1000) + current.memoryMiB)) {
        current.hotPod = entry.pod;
      }
      grouped.set(id, current);
    }

    for (const [namespace, stats] of podCounts) {
      const app = namespaceToApp.get(namespace);
      const id = app?.metadata.name ?? namespace;
      if (!grouped.has(id)) {
        grouped.set(id, {
          id,
          name: app?.metadata.name ?? namespace,
          namespace,
          health: app?.status.health.status ?? "Unknown",
          syncStatus: app?.status.sync.status ?? "Unknown",
          cpuCores: 0,
          memoryMiB: 0,
          podCount: stats.count,
          restarts: stats.restarts,
          hotPod: pods.find((pod) => pod.namespace === namespace)?.name ?? "—",
        });
      }
    }

    return Array.from(grouped.values())
      .sort((left, right) => right.memoryMiB - left.memoryMiB || right.cpuCores - left.cpuCores || right.podCount - left.podCount)
      .slice(0, 8);
  }, [apps, consumersQuery.data, pods]);

  const usageColumns = useMemo<ColumnDef<AppUsageRow>[]>(() => [
    {
      accessorKey: "name",
      header: "Application",
      cell: ({ row }) => (
        <Link
          href={`/apps/${encodeURIComponent(row.original.name)}`}
          className="inline-flex items-center gap-2 font-medium text-[rgb(var(--color-text-primary))] transition-colors hover:text-[rgb(var(--color-brand-600))] dark:hover:text-[rgb(var(--color-brand-500))]"
        >
          <Package className="h-4 w-4 text-[rgb(var(--color-brand-500))]" />
          <span className="truncate">{row.original.name}</span>
        </Link>
      ),
    },
    {
      accessorKey: "namespace",
      header: "Namespace",
    },
    {
      accessorKey: "health",
      header: "Health",
      cell: ({ row }) => <StatusBadge status={row.original.health} size="sm" />,
    },
    {
      accessorKey: "cpuCores",
      header: "CPU",
      cell: ({ row }) => <span className="font-mono">{row.original.cpuCores.toFixed(2)} cores</span>,
    },
    {
      accessorKey: "memoryMiB",
      header: "Memory",
      cell: ({ row }) => <span className="font-mono">{row.original.memoryMiB.toFixed(1)} MiB</span>,
    },
    {
      accessorKey: "podCount",
      header: "Pods",
      cell: ({ row }) => <span className="font-mono">{row.original.podCount}</span>,
    },
    {
      accessorKey: "hotPod",
      header: "Top pod",
      cell: ({ row }) => <span className="block max-w-[16rem] truncate text-[rgb(var(--color-text-secondary))]">{row.original.hotPod}</span>,
    },
  ], []);

  const warningEvents = events.filter((event) => event.type === "Warning").slice(0, 6);
  const latestEvents = warningEvents.length > 0 ? warningEvents : events.slice(0, 6);
  const isRefreshing = [
    clusterQuery.isFetching,
    appsQuery.isFetching,
    nodesQuery.isFetching,
    podsQuery.isFetching,
    eventsQuery.isFetching,
    consumersQuery.isFetching,
  ].some(Boolean);

  const refreshAll = () => {
    void Promise.all([
      clusterQuery.refetch(),
      appsQuery.refetch(),
      nodesQuery.refetch(),
      podsQuery.refetch(),
      eventsQuery.refetch(),
      consumersQuery.refetch(),
    ]);
  };

  return (
    <PageShell
      title="Home"
      subtitle="Azure-quality operations center for live cluster health, workload pressure, and the latest platform activity."
      actions={(
        <>
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-3 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
          >
            <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            Refresh
          </button>
          <Link
            href="/apps"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[rgb(var(--color-brand-600))] px-3 text-sm font-medium text-white transition-colors hover:bg-[rgb(var(--color-brand-700))]"
          >
            Applications
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/cluster"
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-3 text-sm text-[rgb(var(--color-text-primary))] transition-colors hover:border-[rgb(var(--color-border-strong))]"
          >
            Cluster
            <ExternalLink className="h-4 w-4" />
          </Link>
        </>
      )}
      breadcrumb={[{ label: "Overview", href: "/home" }, { label: "Home" }]}
    >
      <section className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-4">
        {metricCards.map((card) => (
          <MetricCard key={card.title} {...card} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
        <DashboardPanel
          title="Cluster health"
          description="Node readiness, deployment state, and workload availability in one command surface."
          icon={Activity}
        >
          {nodesQuery.isError && appsQuery.isError && podsQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Unable to load cluster health"
              description="Health signals could not be loaded right now. Try refreshing the dashboard."
              className="min-h-[320px]"
            />
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-raised))] p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={clusterQuery.data?.status ?? "unknown"} label={(clusterQuery.data?.status ?? "unknown").toUpperCase()} />
                    <span className="text-sm text-[rgb(var(--color-text-secondary))]">
                      {clusterQuery.data ? `${clusterQuery.data.healthy}/${clusterQuery.data.total} platform checks passing` : "Loading live checks…"}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-[rgb(var(--color-text-secondary))]">
                    {clusterQuery.data?.status === "healthy"
                      ? "All critical services are operating within expected thresholds."
                      : "At least one signal is outside the expected operating window and needs review."}
                  </p>
                </div>
                <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] px-4 py-3 text-right">
                  <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]">Last update</p>
                  <p className="mt-1 text-sm font-medium text-[rgb(var(--color-text-primary))]">
                    {eventsQuery.dataUpdatedAt ? new Date(eventsQuery.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
                  </p>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]">Nodes</p>
                  <p className="mt-2 text-2xl font-semibold text-[rgb(var(--color-text-primary))]">{readyNodes}/{nodes.length || 0}</p>
                  <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">ready across the active cluster pool</p>
                </div>
                <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]">Applications</p>
                  <p className="mt-2 text-2xl font-semibold text-[rgb(var(--color-text-primary))]">{healthyApps}/{apps.length || 0}</p>
                  <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">healthy deployments tracked by GitOps</p>
                </div>
                <div className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-[rgb(var(--color-text-tertiary))]">Workloads</p>
                  <p className="mt-2 text-2xl font-semibold text-[rgb(var(--color-text-primary))]">{runningPods}/{pods.length || 0}</p>
                  <p className="mt-1 text-sm text-[rgb(var(--color-text-secondary))]">running pods currently available</p>
                </div>
              </div>

              <div className="space-y-3">
                {nodes.length === 0 && nodesQuery.isLoading ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="h-24 rounded-2xl shimmer-bg" />
                    ))}
                  </div>
                ) : nodes.length === 0 ? (
                  <EmptyState
                    icon={Server}
                    title="No nodes reported"
                    description="The node inventory is empty right now."
                    className="min-h-[220px]"
                  />
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {nodes.map((node) => (
                      <div key={node.name} className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-semibold text-[rgb(var(--color-text-primary))]">{node.name ?? "Unknown node"}</p>
                              <StatusBadge status={node.status === "Ready" ? "healthy" : "failed"} size="sm" label={node.status} />
                            </div>
                            <p className="mt-1 text-xs text-[rgb(var(--color-text-secondary))]">
                              {(node.roles.length > 0 ? node.roles.join(", ") : "worker")} • {node.version ?? "Unknown version"}
                            </p>
                          </div>
                          {node.unschedulable ? <StatusBadge status="warning" size="sm" label="Cordoned" /> : null}
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[rgb(var(--color-text-secondary))]">
                          <span>IP: {node.ip ?? "—"}</span>
                          <span>CPU: {node.cpu ?? "—"}</span>
                          <span>Memory: {node.memory ?? "—"}</span>
                          <span>OS: {node.os ?? "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DashboardPanel>

        <DashboardPanel
          title="Recent activity"
          description="Warning-first operational feed sourced from the latest cluster events."
          icon={Clock3}
        >
          {eventsQuery.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="h-20 rounded-2xl shimmer-bg" />
              ))}
            </div>
          ) : latestEvents.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No recent activity"
              description="The cluster event feed is quiet right now."
              className="min-h-[320px]"
            />
          ) : (
            <div className="space-y-3">
              {latestEvents.map((event) => (
                <div key={event.id} className="rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl",
                        event.type === "Warning"
                          ? "bg-[rgb(var(--color-warning))]/15 text-[rgb(var(--color-warning))]"
                          : "bg-[rgb(var(--color-success))]/15 text-[rgb(var(--color-success))]",
                      )}
                    >
                      {event.type === "Warning" ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-[rgb(var(--color-text-primary))]">{event.reason}</p>
                        <StatusBadge status={event.type === "Warning" ? event.level : "healthy"} size="sm" label={event.type} />
                      </div>
                      <p className="mt-2 text-sm text-[rgb(var(--color-text-secondary))]">{event.message}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[rgb(var(--color-text-tertiary))]">
                        <span>{event.namespace}</span>
                        <span>{event.involvedObject.kind}</span>
                        <span>{timeAgo(event.lastSeen ?? event.firstSeen ?? new Date().toISOString())}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DashboardPanel>
      </section>

      <DashboardPanel
        title="Top apps by resource usage"
        description="Aggregated from live top-consumer metrics and mapped back to deployed applications."
        icon={GitBranch}
        actions={
          <Link href="/apps" className="inline-flex items-center gap-1 text-sm text-[rgb(var(--color-brand-600))] dark:text-[rgb(var(--color-brand-500))]">
            View all apps
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      >
        <DataTable
          columns={usageColumns}
          data={usageRows}
          loading={consumersQuery.isLoading && usageRows.length === 0}
          enableRowSelection={false}
          filterColumn="name"
          filterPlaceholder="Filter applications…"
          exportFileName="infraweaver-top-app-resource-usage"
          emptyState={
            <EmptyState
              icon={Package}
              title="No application usage data"
              description="Live workload metrics are not available yet."
              className="min-h-[260px]"
            />
          }
        />
      </DashboardPanel>
    </PageShell>
  );
}
