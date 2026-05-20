import * as k8s from "@kubernetes/client-node";
import type { HomepageServiceHealth } from "@/lib/homepage-service-config";
import { getArgocdAppsCached, summarizeArgocdApps, type ArgoAppSummary } from "@/lib/argocd-apps";
import { getHomepageServiceHealthMap } from "@/lib/homepage-health";
import { loadKubeConfig } from "@/lib/k8s";
import { loadClusterEvents, type ClusterEventPayload } from "@/lib/ops-data";

export interface PlatformStatusPayload {
  checkedAt: string;
  metrics: { readyNodes: number; totalNodes: number; uptime: string };
  services: Array<{ latencyMs: number; name: string; status: string }>;
  status: string;
}

export interface ClusterHealthPayload {
  checkedAt: string;
  metrics: { readyNodes: number; totalNodes: number; uptime: string };
  services: Array<{ latencyMs: number; name: string; status: string }>;
  status: string;
}

export interface PodStatsPayload {
  running: number;
  total: number;
}

export interface HomeDashboardSummary {
  argocd: ArgoAppSummary | null;
  clusterHealth: ClusterHealthPayload;
  events: ClusterEventPayload;
  homepageHealth: Record<string, HomepageServiceHealth>;
  platformStatus: PlatformStatusPayload;
  pods: PodStatsPayload;
}

function countReadyNodes(nodes: k8s.V1Node[]) {
  return nodes.filter((node) => node.status?.conditions?.find((condition) => condition.type === "Ready")?.status === "True").length;
}

function buildPlatformStatus(totalNodes: number, readyNodes: number): PlatformStatusPayload {
  return {
    status: readyNodes === totalNodes ? "operational" : readyNodes > 0 ? "degraded" : "outage",
    services: [
      { name: "Kubernetes API", status: "operational", latencyMs: 12 },
      { name: "Node Pool", status: readyNodes === totalNodes ? "operational" : "degraded", latencyMs: 0 },
      { name: "ArgoCD", status: "operational", latencyMs: 45 },
      { name: "Longhorn Storage", status: "operational", latencyMs: 8 },
      { name: "Ingress", status: "operational", latencyMs: 3 },
      { name: "Monitoring", status: "operational", latencyMs: 20 },
    ],
    metrics: { totalNodes, readyNodes, uptime: "99.97%" },
    checkedAt: new Date().toISOString(),
  };
}

function buildClusterHealth(totalNodes: number, readyNodes: number): ClusterHealthPayload {
  return {
    status: readyNodes === totalNodes ? "healthy" : readyNodes > 0 ? "degraded" : "outage",
    services: [
      { name: "Kubernetes API", status: "operational", latencyMs: 12 },
      { name: "Node Pool", status: readyNodes === totalNodes ? "operational" : "degraded", latencyMs: 0 },
      { name: "ArgoCD", status: "operational", latencyMs: 45 },
      { name: "Longhorn Storage", status: "operational", latencyMs: 8 },
      { name: "Ingress", status: "operational", latencyMs: 3 },
      { name: "Monitoring", status: "operational", latencyMs: 20 },
    ],
    metrics: { totalNodes, readyNodes, uptime: "99.97%" },
    checkedAt: new Date().toISOString(),
  };
}

async function countPods(coreApi: k8s.CoreV1Api): Promise<PodStatsPayload> {
  let continueToken: string | undefined;
  let total = 0;
  let running = 0;

  do {
    const response = await coreApi.listPodForAllNamespaces({ limit: 500, _continue: continueToken });
    for (const pod of response.items) {
      total += 1;
      if (pod.status?.phase === "Running") {
        running += 1;
      }
    }
    continueToken = response.metadata?._continue || undefined;
  } while (continueToken);

  return { running, total };
}

function buildEmptyEvents(): ClusterEventPayload {
  return {
    events: [],
    live: false,
    summary: {
      total: 0,
      warnings: 0,
      errors: 0,
      namespaces: 0,
    },
  };
}

export async function loadHomeDashboardSummary(options: { includeArgocdSummary: boolean; includeEvents: boolean }): Promise<HomeDashboardSummary> {
  const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);

  const [argocdResult, events, nodesResponse, pods] = await Promise.all([
    getArgocdAppsCached(),
    options.includeEvents ? loadClusterEvents() : Promise.resolve(buildEmptyEvents()),
    coreApi.listNode(),
    countPods(coreApi),
  ]);

  const readyNodes = countReadyNodes(nodesResponse.items);
  const homepageHealth = await getHomepageServiceHealthMap(argocdResult.apps);

  return {
    argocd: options.includeArgocdSummary ? summarizeArgocdApps(argocdResult.apps) : null,
    clusterHealth: buildClusterHealth(nodesResponse.items.length, readyNodes),
    events,
    homepageHealth,
    platformStatus: buildPlatformStatus(nodesResponse.items.length, readyNodes),
    pods,
  };
}
