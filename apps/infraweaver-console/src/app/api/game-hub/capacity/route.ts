import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext } from "@/lib/game-hub";
import { parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { loadKubeConfig } from "@/lib/k8s";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

type NodeTotals = {
  requestedCpu: number;
  requestedMemoryBytes: number;
  limitsCpu: number;
  limitsMemoryBytes: number;
  gameHubRequestedCpu: number;
  gameHubRequestedMemoryBytes: number;
  gameHubLimitsCpu: number;
  gameHubLimitsMemoryBytes: number;
};

function quantityToString(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function percentage(value: number, total: number) {
  if (!total) return 0;
  return Math.round((value / total) * 1000) / 10;
}

function nodeReady(node: { status?: { conditions?: Array<{ type?: string; status?: string }> } }) {
  return node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") ?? false;
}

function addContainerResources(totals: NodeTotals, resources: { requests?: { cpu?: unknown; memory?: unknown }; limits?: { cpu?: unknown; memory?: unknown } } | undefined, isGameHub: boolean) {
  const requestedCpu = parseCpuQuantity(quantityToString(resources?.requests?.cpu));
  const requestedMemoryBytes = parseMemoryBytes(quantityToString(resources?.requests?.memory));
  const limitsCpu = parseCpuQuantity(quantityToString(resources?.limits?.cpu));
  const limitsMemoryBytes = parseMemoryBytes(quantityToString(resources?.limits?.memory));

  totals.requestedCpu += requestedCpu;
  totals.requestedMemoryBytes += requestedMemoryBytes;
  totals.limitsCpu += limitsCpu;
  totals.limitsMemoryBytes += limitsMemoryBytes;

  if (isGameHub) {
    totals.gameHubRequestedCpu += requestedCpu;
    totals.gameHubRequestedMemoryBytes += requestedMemoryBytes;
    totals.gameHubLimitsCpu += limitsCpu;
    totals.gameHubLimitsMemoryBytes += limitsMemoryBytes;
  }
}

function emptyTotals(): NodeTotals {
  return {
    requestedCpu: 0,
    requestedMemoryBytes: 0,
    limitsCpu: 0,
    limitsMemoryBytes: 0,
    gameHubRequestedCpu: 0,
    gameHubRequestedMemoryBytes: 0,
    gameHubLimitsCpu: 0,
    gameHubLimitsMemoryBytes: 0,
  };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 30);
  if (!hasPermission(access.groups, "game-hub:admin", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const plannedMemoryBytes = parseMemoryBytes(req.nextUrl.searchParams.get("memory"));
    const plannedCpu = parseCpuQuantity(req.nextUrl.searchParams.get("cpu"));

    const kc = loadKubeConfig(getRequestClusterId(req));
    const coreApi = kc.makeApiClient((await import("@kubernetes/client-node")).CoreV1Api);
    const customObjectsApi = kc.makeApiClient((await import("@kubernetes/client-node")).CustomObjectsApi);

    const [nodesRes, podsRes, nodeMetricsRes, quota] = await Promise.all([
      coreApi.listNode(),
      coreApi.listPodForAllNamespaces(),
      customObjectsApi.listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "nodes" }).catch(() => ({ items: [] })),
      coreApi.readNamespacedResourceQuota({ name: "game-hub-quota", namespace: GAME_HUB_NAMESPACE }).catch(() => null),
    ]);

    const totalsByNode = new Map<string, NodeTotals>();
    const ensureTotals = (name: string) => {
      if (!totalsByNode.has(name)) totalsByNode.set(name, emptyTotals());
      return totalsByNode.get(name)!;
    };

    for (const pod of podsRes.items ?? []) {
      if (!pod.spec?.nodeName) continue;
      if (pod.status?.phase === "Succeeded" || pod.status?.phase === "Failed") continue;
      const totals = ensureTotals(pod.spec.nodeName);
      const isGameHub = pod.metadata?.namespace === GAME_HUB_NAMESPACE;
      for (const container of pod.spec.containers ?? []) {
        addContainerResources(totals, container.resources, isGameHub);
      }
    }

    const metricsItems = ((nodeMetricsRes as { items?: Array<{ metadata?: { name?: string }; usage?: { cpu?: string; memory?: string } }> }).items ?? []);
    const usageByNode = new Map(metricsItems.map((item) => [
      item.metadata?.name ?? "",
      {
        cpu: parseCpuQuantity(item.usage?.cpu ?? null),
        memoryBytes: parseMemoryBytes(item.usage?.memory ?? null),
      },
    ]));

    const nodes = (nodesRes.items ?? []).map((node) => {
      const name = node.metadata?.name ?? "unknown";
      const allocatableCpu = parseCpuQuantity(quantityToString(node.status?.allocatable?.cpu));
      const allocatableMemoryBytes = parseMemoryBytes(quantityToString(node.status?.allocatable?.memory));
      const totals = totalsByNode.get(name) ?? emptyTotals();
      const usage = usageByNode.get(name) ?? null;
      return {
        name,
        ready: nodeReady(node),
        allocatableCpu,
        allocatableMemoryBytes,
        requestedCpu: totals.requestedCpu,
        requestedMemoryBytes: totals.requestedMemoryBytes,
        limitsCpu: totals.limitsCpu,
        limitsMemoryBytes: totals.limitsMemoryBytes,
        usageCpu: usage?.cpu ?? null,
        usageMemoryBytes: usage?.memoryBytes ?? null,
        requestCpuPct: percentage(totals.requestedCpu, allocatableCpu),
        requestMemoryPct: percentage(totals.requestedMemoryBytes, allocatableMemoryBytes),
        limitCpuPct: percentage(totals.limitsCpu, allocatableCpu),
        limitMemoryPct: percentage(totals.limitsMemoryBytes, allocatableMemoryBytes),
        usageCpuPct: usage ? percentage(usage.cpu, allocatableCpu) : null,
        usageMemoryPct: usage ? percentage(usage.memoryBytes, allocatableMemoryBytes) : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const readyNodes = nodes.filter((node) => node.ready && node.allocatableMemoryBytes > 0);
    const maxRequestMemoryPct = readyNodes.length > 0 ? Math.max(...readyNodes.map((node) => node.requestMemoryPct)) : 0;
    const maxLimitMemoryPct = readyNodes.length > 0 ? Math.max(...readyNodes.map((node) => node.limitMemoryPct)) : 0;
    const maxUsageMemoryPct = readyNodes.length > 0
      ? readyNodes.reduce<number | null>((max, node) => {
          if (node.usageMemoryPct == null) return max;
          return max == null ? node.usageMemoryPct : Math.max(max, node.usageMemoryPct);
        }, null)
      : null;
    const projectedWorstNodeRequestMemoryPct = readyNodes.length > 0
      ? Math.max(...readyNodes.map((node) => percentage(node.requestedMemoryBytes + plannedMemoryBytes, node.allocatableMemoryBytes)))
      : 0;
    const projectedWorstNodeLimitMemoryPct = readyNodes.length > 0
      ? Math.max(...readyNodes.map((node) => percentage(node.limitsMemoryBytes + plannedMemoryBytes, node.allocatableMemoryBytes)))
      : 0;

    const quotaHard = quota?.spec?.hard ?? {};
    const quotaUsage = quota?.status?.used ?? {};
    const quotaRequestMemoryBytes = parseMemoryBytes(quantityToString(quotaHard["requests.memory"]));
    const quotaLimitMemoryBytes = parseMemoryBytes(quantityToString(quotaHard["limits.memory"]));
    const quotaRequestCpu = parseCpuQuantity(quantityToString(quotaHard["requests.cpu"]));
    const quotaLimitCpu = parseCpuQuantity(quantityToString(quotaHard["limits.cpu"]));
    const quotaPodCount = Number.parseInt(quantityToString(quotaHard["count/pods"]) ?? "0", 10) || 0;
    const quotaPvcCount = Number.parseInt(quantityToString(quotaHard.persistentvolumeclaims) ?? "0", 10) || 0;

    const gameHubUsage = Array.from(totalsByNode.values()).reduce((acc, totals) => ({
      requestedCpu: acc.requestedCpu + totals.gameHubRequestedCpu,
      requestedMemoryBytes: acc.requestedMemoryBytes + totals.gameHubRequestedMemoryBytes,
      limitsCpu: acc.limitsCpu + totals.gameHubLimitsCpu,
      limitsMemoryBytes: acc.limitsMemoryBytes + totals.gameHubLimitsMemoryBytes,
    }), {
      requestedCpu: 0,
      requestedMemoryBytes: 0,
      limitsCpu: 0,
      limitsMemoryBytes: 0,
    });

    const gameHubPods = (podsRes.items ?? []).filter((pod) => pod.metadata?.namespace === GAME_HUB_NAMESPACE && pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed");

    const warnings: string[] = [];
    if (maxUsageMemoryPct != null && maxUsageMemoryPct > 70) {
      warnings.push(`Current observed node memory usage is ${maxUsageMemoryPct.toFixed(1)}%, above the 70% safety threshold.`);
    }
    if (projectedWorstNodeRequestMemoryPct > 70) {
      warnings.push(`Projected worst-case node memory requests would reach ${projectedWorstNodeRequestMemoryPct.toFixed(1)}%.`);
    }
    if (maxLimitMemoryPct > 100) {
      warnings.push(`Current node memory limits are already overcommitted at ${maxLimitMemoryPct.toFixed(1)}%.`);
    }
    if (projectedWorstNodeLimitMemoryPct > 100) {
      warnings.push(`Projected worst-case node memory limits would reach ${projectedWorstNodeLimitMemoryPct.toFixed(1)}%.`);
    }
    if (quotaRequestMemoryBytes > 0 && gameHubUsage.requestedMemoryBytes + plannedMemoryBytes > quotaRequestMemoryBytes) {
      warnings.push("This deployment would exceed the game-hub requests.memory quota.");
    }
    if (quotaRequestCpu > 0 && gameHubUsage.requestedCpu + plannedCpu > quotaRequestCpu) {
      warnings.push("This deployment would exceed the game-hub requests.cpu quota.");
    }

    return NextResponse.json({
      nodes,
      gameHubUsage: {
        ...gameHubUsage,
        podCount: gameHubPods.length,
        quota: {
          requestsMemoryBytes: quotaRequestMemoryBytes,
          requestsCpu: quotaRequestCpu,
          limitsMemoryBytes: quotaLimitMemoryBytes,
          limitsCpu: quotaLimitCpu,
          podCount: quotaPodCount,
          pvcCount: quotaPvcCount,
          usedRequestsMemoryBytes: parseMemoryBytes(quantityToString(quotaUsage["requests.memory"])),
          usedRequestsCpu: parseCpuQuantity(quantityToString(quotaUsage["requests.cpu"])),
          usedLimitsMemoryBytes: parseMemoryBytes(quantityToString(quotaUsage["limits.memory"])),
          usedLimitsCpu: parseCpuQuantity(quantityToString(quotaUsage["limits.cpu"])),
          usedPodCount: Number.parseInt(quantityToString(quotaUsage["count/pods"]) ?? "0", 10) || 0,
          usedPvcCount: Number.parseInt(quantityToString(quotaUsage.persistentvolumeclaims) ?? "0", 10) || 0,
        },
      },
      plannedWorkload: {
        cpu: plannedCpu,
        memoryBytes: plannedMemoryBytes,
      },
      summary: {
        maxRequestMemoryPct,
        maxLimitMemoryPct,
        maxUsageMemoryPct,
        projectedWorstNodeRequestMemoryPct,
        projectedWorstNodeLimitMemoryPct,
      },
      canSafelyDeploy: warnings.length === 0,
      warnings,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("game hub capacity check failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
