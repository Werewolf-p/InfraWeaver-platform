import { NextResponse } from "next/server";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import { makeGameHubClients, parseCpuQuantity, parseMemoryBytes } from "@/lib/game-hub-server";
import { withAuth } from "@/lib/with-auth";
import { safeError } from "@/lib/utils";

type PodMetricsResponse = {
  items?: Array<{
    metadata?: { name?: string };
    containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
  }>;
};

function roundMetric(value: number) {
  return Math.round(value * 100) / 100;
}

export const GET = withAuth(
  {
    permission: "game-hub:read",
    scope: "/game-hub/",
    rateLimit: { name: "game-hub-resource-summary", limit: 10, windowMs: 60_000 },
  },
  async () => {
    try {
      const clients = makeGameHubClients();
      const [deployments, pods, pvcs, metrics] = await Promise.all([
        clients.appsApi.listNamespacedDeployment({ namespace: GAME_HUB_NAMESPACE, labelSelector: "infraweaver/game=true" }),
        clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: "infraweaver/game=true" }),
        clients.coreApi.listNamespacedPersistentVolumeClaim({ namespace: GAME_HUB_NAMESPACE, labelSelector: "infraweaver/game=true" }),
        clients.customObjectsApi.listNamespacedCustomObject({
          group: "metrics.k8s.io",
          version: "v1beta1",
          namespace: GAME_HUB_NAMESPACE,
          plural: "pods",
        }).catch(() => null),
      ]);

      const serverCount = (deployments.items ?? []).length;
      const runningCount = (deployments.items ?? []).filter((deployment) => (deployment.status?.readyReplicas ?? 0) > 0).length;
      const stoppedCount = (deployments.items ?? []).filter((deployment) => (deployment.spec?.replicas ?? 0) === 0).length;

      let totalCpuLimitCores = 0;
      let totalRamLimitGB = 0;
      let totalCpuRequestCores = 0;
      let totalRamRequestGB = 0;
      for (const deployment of deployments.items ?? []) {
        for (const container of deployment.spec?.template?.spec?.containers ?? []) {
          totalCpuLimitCores += parseCpuQuantity(typeof container.resources?.limits?.cpu === "string" ? container.resources.limits.cpu : null);
          totalRamLimitGB += parseMemoryBytes(typeof container.resources?.limits?.memory === "string" ? container.resources.limits.memory : null) / 1024 ** 3;
          totalCpuRequestCores += parseCpuQuantity(typeof container.resources?.requests?.cpu === "string" ? container.resources.requests.cpu : null);
          totalRamRequestGB += parseMemoryBytes(typeof container.resources?.requests?.memory === "string" ? container.resources.requests.memory : null) / 1024 ** 3;
        }
      }

      const activePodNames = new Set(
        (pods.items ?? [])
          .filter((pod) => pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed")
          .map((pod) => pod.metadata?.name ?? "")
          .filter(Boolean),
      );
      let totalCpuUsedCores: number | null = null;
      let totalRamUsedGB: number | null = null;
      if (metrics) {
        totalCpuUsedCores = 0;
        totalRamUsedGB = 0;
        for (const item of ((metrics as PodMetricsResponse).items ?? [])) {
          if (!activePodNames.has(item.metadata?.name ?? "")) continue;
          totalCpuUsedCores += (item.containers ?? []).reduce((sum, container) => sum + parseCpuQuantity(container.usage?.cpu ?? null), 0);
          totalRamUsedGB += (item.containers ?? []).reduce((sum, container) => sum + parseMemoryBytes(container.usage?.memory ?? null) / 1024 ** 3, 0);
        }
      }

      const storageGB = (pvcs.items ?? []).reduce((sum, pvc) => (
        sum + parseMemoryBytes(typeof pvc.spec?.resources?.requests?.storage === "string" ? pvc.spec.resources.requests.storage : null) / 1024 ** 3
      ), 0);
      const estimatedMonthlyCost = roundMetric(
        totalCpuLimitCores * 0.048 * 24 * 30
        + totalRamLimitGB * 0.006 * 24 * 30
        + storageGB * 0.10,
      );

      return NextResponse.json({
        totalCpuLimitCores: roundMetric(totalCpuLimitCores),
        totalRamLimitGB: roundMetric(totalRamLimitGB),
        totalCpuRequestCores: roundMetric(totalCpuRequestCores),
        totalRamRequestGB: roundMetric(totalRamRequestGB),
        totalCpuUsedCores: totalCpuUsedCores == null ? null : roundMetric(totalCpuUsedCores),
        totalRamUsedGB: totalRamUsedGB == null ? null : roundMetric(totalRamUsedGB),
        serverCount,
        runningCount,
        stoppedCount,
        estimatedMonthlyCost,
      });
    } catch (error) {
      console.error("resource summary failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
