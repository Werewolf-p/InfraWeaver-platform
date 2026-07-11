import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { getRequestClusterId } from "@/lib/cluster-context";
import { apiCache } from "@/lib/api-cache";
import { loadKubeConfig } from "@/lib/k8s";
import { PERFORMANCE_CACHE_KEYS } from "@/lib/performance-cache";
import { withAuth } from "@/lib/with-auth";

const METRICS_CACHE_TTL_MS = 20_000;

type MetricsResponse = {
  degraded?: boolean;
  metrics: Array<{ cpuMillicores: number; cpuPct: number; memKi: number; memPct: number; name: string }>;
  timestamp: string;
};

function parseMemoryToKi(memory = "0Ki") {
  if (memory.endsWith("Ki")) return parseInt(memory, 10) || 0;
  if (memory.endsWith("Mi")) return (parseInt(memory, 10) || 0) * 1024;
  if (memory.endsWith("Gi")) return (parseInt(memory, 10) || 0) * 1024 * 1024;
  return Math.floor((parseInt(memory, 10) || 0) / 1024);
}

function parseCpuToMillicores(cpu = "0n") {
  if (cpu.endsWith("n")) return (parseInt(cpu, 10) || 0) / 1_000_000;
  if (cpu.endsWith("m")) return parseInt(cpu, 10) || 0;
  return (parseFloat(cpu) || 0) * 1000;
}

async function loadMetrics(clusterId: string): Promise<MetricsResponse> {
  try {
    const kc = loadKubeConfig(clusterId);
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const [metricsResponse, nodesResponse] = await Promise.all([
      customApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" }) as Promise<{ items?: Array<{ metadata?: { name?: string }; usage?: { cpu?: string; memory?: string } }> }>,
      coreApi.listNode(),
    ]);

    const capacities = Object.fromEntries(nodesResponse.items.map((node) => {
      const name = node.metadata?.name ?? "";
      return [name, {
        cpuCores: parseFloat(node.status?.capacity?.cpu ?? "0") || 0,
        memoryKi: parseMemoryToKi(node.status?.capacity?.memory ?? "0Ki"),
      }];
    }));

    return {
      metrics: (metricsResponse.items ?? []).map((item) => {
        const name = item.metadata?.name ?? "";
        const cpuMillicores = Math.round(parseCpuToMillicores(item.usage?.cpu ?? "0n"));
        const memKi = parseMemoryToKi(item.usage?.memory ?? "0Ki");
        const capacity = capacities[name] ?? { cpuCores: 8, memoryKi: 14_306_560 };
        const cpuPct = capacity.cpuCores > 0 ? Math.round((cpuMillicores / (capacity.cpuCores * 1000)) * 100) : 0;
        const memPct = capacity.memoryKi > 0 ? Math.round((memKi / capacity.memoryKi) * 100) : 0;
        return { name, cpuPct: Math.min(cpuPct, 100), memPct: Math.min(memPct, 100), cpuMillicores, memKi };
      }),
      timestamp: new Date().toISOString(),
    };
  } catch {
    return { degraded: true, metrics: [], timestamp: new Date().toISOString() };
  }
}

export const GET = withAuth({ permission: "config:read" }, async ({ req }) => {
  const clusterId = getRequestClusterId(req);
  const cacheKey = `${PERFORMANCE_CACHE_KEYS.clusterMetrics}:${clusterId}`;
  const cached = apiCache.get<MetricsResponse>(cacheKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "X-Cache": "HIT" } });
  }

  const response = await loadMetrics(clusterId);
  if (!response.degraded) {
    apiCache.set(cacheKey, response, METRICS_CACHE_TTL_MS);
  }
  return NextResponse.json(response, { headers: { "X-Cache": "MISS" } });
});
