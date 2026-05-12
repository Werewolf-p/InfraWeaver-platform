import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { GAME_HUB_NS, getServerDeployment, makeGameHubClients, parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

type MetricPoint = {
  cpu: number;
  cpuLimit: number;
  memory: number;
  memoryLimit: number;
  timestamp: string;
};

type PodMetricsResponse = {
  items?: Array<{
    metadata?: { name?: string };
    containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
  }>;
};

const metricsCache = new Map<string, { updatedAt: number; data: MetricPoint[] }>();

async function readMetrics(name: string): Promise<MetricPoint[]> {
  const cached = metricsCache.get(name);
  if (cached && Date.now() - cached.updatedAt < 15_000) {
    return cached.data;
  }

  const { appsApi, customObjectsApi } = makeGameHubClients();
  const deployment = await getServerDeployment(appsApi, name);
  const limits = deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits;
  const cpuLimit = parseCpuQuantity(typeof limits?.cpu === "string" ? limits.cpu : null);
  const memoryLimit = parseMemoryBytes(typeof limits?.memory === "string" ? limits.memory : null);
  const podMetrics = await customObjectsApi.listNamespacedCustomObject({
    group: "metrics.k8s.io",
    version: "v1beta1",
    namespace: GAME_HUB_NS,
    plural: "pods",
  }) as unknown as PodMetricsResponse;

  const matching = (podMetrics.items ?? []).filter((item) => (item.metadata?.name ?? "").startsWith(`${name}-`));
  const cpu = matching.reduce((sum, item) => sum + (item.containers ?? []).reduce((inner, container) => inner + parseCpuQuantity(container.usage?.cpu ?? null), 0), 0);
  const memory = matching.reduce((sum, item) => sum + (item.containers ?? []).reduce((inner, container) => inner + parseMemoryBytes(container.usage?.memory ?? null), 0), 0);
  const nextPoint: MetricPoint = {
    cpu,
    cpuLimit,
    memory,
    memoryLimit,
    timestamp: new Date().toISOString(),
  };

  const nextData = [...(cached?.data ?? []), nextPoint].slice(-20);
  metricsCache.set(name, { updatedAt: Date.now(), data: nextData });
  return nextData;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const points = await readMetrics(name);
    return NextResponse.json(points);
  } catch (error) {
    console.error("metrics route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
