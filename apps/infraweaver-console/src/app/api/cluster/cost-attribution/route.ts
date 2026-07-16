import { NextResponse } from "next/server";
import { parseCpuMillicores, parseMemoryMi } from "@/lib/k8s-quantity";
import { makeCoreApi, makeCustomApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import { attributeCost, type NamespaceResourceTotals } from "@/lib/finops/cost-attribution";

/**
 * Per-namespace requested-vs-used dollar attribution. Sums container REQUESTS
 * (pod spec) and USAGE (metrics.k8s.io) per namespace, then prices both via the
 * shared FinOps cost model to expose reclaimable (idle) spend.
 */

export const GET = withAuth({ permission: ["infra:read", "config:read"] }, async () => {
  try {
    const coreApi = makeCoreApi();
    const [podsResp, metricsResp] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      makeCustomApi().listClusterCustomObject({ group: "metrics.k8s.io", version: "v1beta1", plural: "pods" }),
    ]);

    const requestedByNs = new Map<string, { cpuM: number; memMi: number }>();
    for (const item of (podsResp as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        metadata?: { namespace?: string };
        spec?: { containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> };
        status?: { phase?: string };
      };
      const namespace = pod.metadata?.namespace ?? "";
      if (!namespace) continue;
      if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
      const acc = requestedByNs.get(namespace) ?? { cpuM: 0, memMi: 0 };
      for (const container of pod.spec?.containers ?? []) {
        acc.cpuM += parseCpuMillicores(container.resources?.requests?.cpu);
        acc.memMi += parseMemoryMi(container.resources?.requests?.memory);
      }
      requestedByNs.set(namespace, acc);
    }

    const usedByNs = new Map<string, { cpuM: number; memMi: number }>();
    for (const item of (metricsResp as { items?: unknown[] }).items ?? []) {
      const metric = item as {
        metadata?: { namespace?: string };
        containers?: Array<{ usage?: { cpu?: string; memory?: string } }>;
      };
      const namespace = metric.metadata?.namespace ?? "";
      if (!namespace) continue;
      const acc = usedByNs.get(namespace) ?? { cpuM: 0, memMi: 0 };
      for (const container of metric.containers ?? []) {
        acc.cpuM += parseCpuMillicores(container.usage?.cpu);
        acc.memMi += parseMemoryMi(container.usage?.memory);
      }
      usedByNs.set(namespace, acc);
    }

    const toTotals = (map: Map<string, { cpuM: number; memMi: number }>): NamespaceResourceTotals[] =>
      [...map.entries()].map(([namespace, v]) => ({ namespace, cpuM: v.cpuM, memMi: v.memMi }));

    return NextResponse.json({ ...attributeCost(toTotals(requestedByNs), toTotals(usedByNs)), live: true });
  } catch {
    return NextResponse.json({ namespaces: [], totals: { requestedUsd: 0, usedUsd: 0, reclaimableUsd: 0 }, live: false });
  }
});
