"use client";

import { useMemo, useState } from "react";
import { Gauge, Siren } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AutoRefreshControl } from "@/components/ui/auto-refresh-control";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { ExportButton } from "@/components/ui/export-button";
import { useApiQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { serializeRows } from "@/lib/export-serializers";
import type { ArgoApplication, ArgoAppSummary } from "@/lib/argocd-apps";
import type { CronJobPayload } from "@/lib/ops-data";
import type { SecretLifecycleReport } from "@/lib/secrets/lifecycle-types";
import { aggregateSignals, type SignalSource } from "@/lib/observability-signals";
import { SignalSummaryStrip } from "./_widgets/signal-summary-strip";
import { BrewingIncidentsFeed } from "./_widgets/brewing-incidents-feed";
import { ArgoSyncWidget } from "./_widgets/argo-sync-widget";
import { SecretHealthWidget } from "./_widgets/secret-health-widget";
import { ResourcePressureWidget } from "./_widgets/resource-pressure-widget";
import { CronHealthWidget } from "./_widgets/cron-health-widget";
import { PostureWidget, type PostureData } from "./_widgets/posture-widget";
import { ReliabilityWidget, type ReliabilityData } from "./_widgets/reliability-widget";

const DEFAULT_REFRESH_MS = 30_000;

interface OomEventsResponse {
  events: Array<{ pod: string; namespace: string; timestamp: string | null }>;
}
interface MemoryPressureResponse {
  nodes: Array<{ name: string; pressure_pct: number; status: string }>;
}
interface TopConsumersResponse {
  memory: Array<{ pod: string; namespace: string; memory_pct: number }>;
}
interface NodesResponse {
  nodes: Array<{ status?: string }>;
}

/**
 * Client-side mirror of {@link import("@/lib/argocd-apps").summarizeArgocdApps}.
 * That lib pulls in the Kubernetes client (server-only), so the health/sync
 * counting is duplicated here — a handful of pure `.filter` calls — to keep this
 * client component's bundle free of node-only dependencies.
 */
function summarizeApps(apps: ArgoApplication[]): ArgoAppSummary {
  const healthOf = (app: ArgoApplication) => app.status?.health?.status ?? "";
  const healthy = apps.filter((app) => healthOf(app) === "Healthy").length;
  const degraded = apps.filter((app) => healthOf(app) === "Degraded").length;
  const progressing = apps.filter((app) => healthOf(app) === "Progressing").length;
  const outOfSync = apps.filter((app) => app.status?.sync?.status === "OutOfSync").length;
  const issues = apps.filter((app) => ["Degraded", "Failed", "Missing"].includes(healthOf(app))).length;
  return {
    degraded,
    healthy,
    issues,
    outOfSync,
    progressing,
    status: degraded > 0 ? "degraded" : progressing > 0 ? "progressing" : healthy > 0 ? "healthy" : "unknown",
    total: apps.length,
  };
}

export function ObservabilityBoardView() {
  const [refreshInterval, setRefreshInterval] = useState<number>(DEFAULT_REFRESH_MS);
  const interval = refreshInterval || false;

  const argoQuery = useApiQuery<ArgoApplication[]>({ queryKey: queryKeys.argocd.apps(), path: "/api/argocd/apps", refetchInterval: interval, staleTime: 15_000 });
  const reliabilityQuery = useApiQuery<ReliabilityData>({ queryKey: ["observability", "reliability"], path: "/api/health/reliability", refetchInterval: interval, staleTime: 30_000 });
  const postureQuery = useApiQuery<PostureData>({ queryKey: ["observability", "posture"], path: "/api/security/posture", refetchInterval: interval, staleTime: 60_000 });
  const oomQuery = useApiQuery<OomEventsResponse>({ queryKey: ["observability", "oom"], path: "/api/cluster/oom-events", refetchInterval: interval, staleTime: 30_000 });
  const memPressureQuery = useApiQuery<MemoryPressureResponse>({ queryKey: ["observability", "mem-pressure"], path: "/api/cluster/memory-pressure", refetchInterval: interval, staleTime: 30_000 });
  const topConsumersQuery = useApiQuery<TopConsumersResponse>({ queryKey: queryKeys.cluster.topConsumers(), path: "/api/cluster/top-consumers", refetchInterval: interval, staleTime: 30_000 });
  const nodesQuery = useApiQuery<NodesResponse>({ queryKey: queryKeys.cluster.nodes(), path: "/api/cluster/nodes", refetchInterval: interval, staleTime: 30_000 });
  const cronQuery = useApiQuery<CronJobPayload>({ queryKey: ["observability", "cronjobs"], path: "/api/cluster/cronjobs", refetchInterval: interval, staleTime: 30_000 });
  const secretsQuery = useApiQuery<SecretLifecycleReport>({ queryKey: queryKeys.secrets.lifecycle(), path: "/api/secrets/lifecycle", refetchInterval: interval, staleTime: 30_000 });

  const argoSummary = useMemo(() => (argoQuery.data ? summarizeApps(argoQuery.data) : undefined), [argoQuery.data]);
  const cronjobs = useMemo(() => cronQuery.data?.cronjobs ?? [], [cronQuery.data]);
  const topMem = useMemo(() => topConsumersQuery.data?.memory ?? [], [topConsumersQuery.data]);

  const nodesNotReady = (nodesQuery.data?.nodes ?? []).filter((node) => (node.status ?? "").toLowerCase() !== "ready").length;
  const maxMemPct = Math.max(0, ...(memPressureQuery.data?.nodes ?? []).map((node) => node.pressure_pct));
  const oomEvents = oomQuery.data?.events ?? [];

  const resourceInput = useMemo(
    () => ({ oomEvents, nodesNotReady, maxMemPressurePct: maxMemPct }),
    [oomEvents, nodesNotReady, maxMemPct],
  );

  const now = Date.now();
  const summary = useMemo(
    () =>
      aggregateSignals({
        argo: argoQuery.data ? argoSummary : null,
        secrets: secretsQuery.data ?? null,
        cron: cronQuery.data ? cronjobs : null,
        posture: postureQuery.data ? { score: postureQuery.data.score, grade: postureQuery.data.grade } : null,
        resource: oomQuery.data || memPressureQuery.data || nodesQuery.data ? resourceInput : null,
        reliability: reliabilityQuery.data ? { score: reliabilityQuery.data.score, grade: reliabilityQuery.data.grade } : null,
        now,
      }),
    // `now` intentionally excluded — it re-derives every render; data deps drive recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [argoQuery.data, argoSummary, secretsQuery.data, cronQuery.data, cronjobs, postureQuery.data, oomQuery.data, memPressureQuery.data, nodesQuery.data, resourceInput, reliabilityQuery.data],
  );

  const signalFor = (source: SignalSource) => summary.signals.find((signal) => signal.source === source);

  const anyLoading = argoQuery.isLoading && reliabilityQuery.isLoading && postureQuery.isLoading && cronQuery.isLoading;

  const refetchAll = () => {
    void argoQuery.refetch();
    void reliabilityQuery.refetch();
    void postureQuery.refetch();
    void oomQuery.refetch();
    void memPressureQuery.refetch();
    void topConsumersQuery.refetch();
    void nodesQuery.refetch();
    void cronQuery.refetch();
    void secretsQuery.refetch();
  };

  const exportData = (format: "csv" | "json" | "yaml") => {
    if (format === "json") {
      return JSON.stringify({ exportedAt: new Date().toISOString(), ...summary }, null, 2);
    }
    return serializeRows(summary.signals.map((signal) => ({ ...signal })), format);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Gauge}
        title="Signals"
        subtitle="What breaks next — proactive rollup of ArgoCD, secrets, resources, crons, posture, and reliability"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportButton getData={exportData} filename="observability-signals" formats={["csv", "json"]} />
            <AutoRefreshControl interval={refreshInterval} onChange={setRefreshInterval} onRefreshNow={refetchAll} />
          </div>
        }
      />

      <SignalSummaryStrip summary={summary} isLoading={anyLoading} />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ArgoSyncWidget signal={signalFor("argocd")} summary={argoSummary} isLoading={argoQuery.isLoading} isError={argoQuery.isError} />
        <SecretHealthWidget />
        <ReliabilityWidget signal={signalFor("reliability")} reliability={reliabilityQuery.data} isLoading={reliabilityQuery.isLoading} isError={reliabilityQuery.isError} />
        <CronHealthWidget signal={signalFor("cron")} cronjobs={cronjobs} now={now} isLoading={cronQuery.isLoading} isError={cronQuery.isError} />
        <ResourcePressureWidget
          signal={signalFor("resources")}
          recentOom={oomEvents.length}
          nodesNotReady={nodesNotReady}
          maxMemPct={maxMemPct}
          topMem={topMem}
          isLoading={oomQuery.isLoading && memPressureQuery.isLoading && nodesQuery.isLoading}
          isError={oomQuery.isError && memPressureQuery.isError && nodesQuery.isError}
        />
        <PostureWidget signal={signalFor("posture")} posture={postureQuery.data} isLoading={postureQuery.isLoading} isError={postureQuery.isError} />
      </div>

      <DashboardPanel
        title="Brewing incidents"
        description="Every non-healthy signal, worst-first — each row deep-links to the page that owns the fix."
        icon={Siren}
        actions={<span className="text-xs text-gray-500 dark:text-[#888]">{summary.criticalCount + summary.warnCount} active</span>}
      >
        <BrewingIncidentsFeed signals={summary.signals} />
      </DashboardPanel>
    </div>
  );
}
