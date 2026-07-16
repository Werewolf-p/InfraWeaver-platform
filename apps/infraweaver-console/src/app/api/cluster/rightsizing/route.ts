import { NextResponse } from "next/server";
import { parseCpuMillicores, parseMemoryMi } from "@/lib/k8s-quantity";
import { makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import { assessContainers, type ContainerUsage } from "@/lib/finops/rightsizing";

/**
 * Real rightsizing: join each container's REQUESTED cpu/mem (pod spec) against
 * its ACTUAL usage (metrics.k8s.io) and recommend a new request. Replaces the
 * old resource-recommendations stub that always said "optimal". Same
 * pod/metrics join as /cluster/top-consumers, but kept per-container.
 */

interface PodSpecContainer {
  name?: string;
  resources?: { requests?: { cpu?: string; memory?: string } };
}
interface MetricsContainer {
  name?: string;
  usage?: { cpu?: string; memory?: string };
}

export const GET = withAuth({ permission: ["infra:read", "config:read"] }, async () => {
  try {
    const coreApi = makeCoreApi();
    const [podsResp, metricsResp] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      makeCustomApi().listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "pods" }),
    ]);

    // pod → per-container REQUESTS (skip terminal pods).
    const requestsByKey = new Map<string, { requestCpuM: number; requestMemMi: number }>();
    for (const item of (podsResp as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        metadata?: { name?: string; namespace?: string };
        spec?: { containers?: PodSpecContainer[] };
        status?: { phase?: string };
      };
      const namespace = pod.metadata?.namespace ?? "";
      const podName = pod.metadata?.name ?? "";
      if (!namespace || !podName) continue;
      if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
      for (const container of pod.spec?.containers ?? []) {
        const containerName = container.name ?? "";
        if (!containerName) continue;
        requestsByKey.set(`${namespace}/${podName}/${containerName}`, {
          requestCpuM: parseCpuMillicores(container.resources?.requests?.cpu),
          requestMemMi: parseMemoryMi(container.resources?.requests?.memory),
        });
      }
    }

    // pod → per-container USAGE.
    const usageByKey = new Map<string, { usageCpuM: number; usageMemMi: number }>();
    for (const item of (metricsResp as { items?: unknown[] }).items ?? []) {
      const metric = item as {
        metadata?: { name?: string; namespace?: string };
        containers?: MetricsContainer[];
      };
      const namespace = metric.metadata?.namespace ?? "";
      const podName = metric.metadata?.name ?? "";
      if (!namespace || !podName) continue;
      for (const container of metric.containers ?? []) {
        const containerName = container.name ?? "";
        if (!containerName) continue;
        usageByKey.set(`${namespace}/${podName}/${containerName}`, {
          usageCpuM: parseCpuMillicores(container.usage?.cpu),
          usageMemMi: parseMemoryMi(container.usage?.memory),
        });
      }
    }

    const inputs: ContainerUsage[] = [];
    for (const [key, requests] of requestsByKey) {
      const [namespace, pod, container] = key.split("/");
      const usage = usageByKey.get(key);
      inputs.push({
        namespace,
        pod,
        container,
        requestCpuM: Math.round(requests.requestCpuM),
        requestMemMi: Math.round(requests.requestMemMi),
        usageCpuM: usage ? Math.round(usage.usageCpuM) : 0,
        usageMemMi: usage ? Math.round(usage.usageMemMi) : 0,
        hasMetrics: usage !== undefined,
      });
    }

    const { recommendations, summary } = assessContainers(inputs);
    return NextResponse.json({ recommendations, summary, live: true });
  } catch {
    // metrics-server or the API unreachable — honest empty, not fabricated.
    return NextResponse.json({
      recommendations: [],
      summary: { analyzed: 0, overCount: 0, underCount: 0, optimalCount: 0, noMetricsCount: 0, totalMonthlyWasteUsd: 0 },
      live: false,
    });
  }
});
