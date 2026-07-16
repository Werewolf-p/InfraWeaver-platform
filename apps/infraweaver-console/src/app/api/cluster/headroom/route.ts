import { NextResponse } from "next/server";
import { parseCpuMillicores, parseMemoryMi } from "@/lib/k8s-quantity";
import { makeCoreApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import { computeHeadroom, fitReplicas, type NodeCapacity } from "@/lib/finops/headroom";

/**
 * Per-node free capacity (allocatable − summed pod requests) + optional
 * "how many replicas of ?cpu=&mem= fit" estimate. Pure math over listNode +
 * listPod, no metrics-server dependency.
 */
export const GET = withAuth({ permission: ["infra:read", "config:read"] }, async ({ req }) => {
  try {
    const coreApi = makeCoreApi();
    const [nodesResp, podsResp] = await Promise.all([coreApi.listNode(), coreApi.listPodForAllNamespaces()]);

    const requestedByNode = new Map<string, { cpuM: number; memMi: number }>();
    for (const item of (podsResp as { items?: unknown[] }).items ?? []) {
      const pod = item as {
        spec?: { nodeName?: string; containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> };
        status?: { phase?: string };
      };
      const nodeName = pod.spec?.nodeName ?? "";
      if (!nodeName) continue;
      if (["Succeeded", "Failed"].includes(pod.status?.phase ?? "")) continue;
      const acc = requestedByNode.get(nodeName) ?? { cpuM: 0, memMi: 0 };
      for (const container of pod.spec?.containers ?? []) {
        acc.cpuM += parseCpuMillicores(container.resources?.requests?.cpu);
        acc.memMi += parseMemoryMi(container.resources?.requests?.memory);
      }
      requestedByNode.set(nodeName, acc);
    }

    const nodes: NodeCapacity[] = ((nodesResp as { items?: unknown[] }).items ?? []).map((item) => {
      const node = item as { metadata?: { name?: string }; status?: { allocatable?: { cpu?: string; memory?: string } } };
      const name = node.metadata?.name ?? "";
      const requested = requestedByNode.get(name) ?? { cpuM: 0, memMi: 0 };
      return {
        name,
        allocatableCpuM: Math.round(parseCpuMillicores(node.status?.allocatable?.cpu)),
        allocatableMemMi: Math.round(parseMemoryMi(node.status?.allocatable?.memory)),
        requestedCpuM: Math.round(requested.cpuM),
        requestedMemMi: Math.round(requested.memMi),
      };
    }).filter((n) => n.name);

    const headroom = computeHeadroom(nodes);

    const reqCpuM = Number(req.nextUrl.searchParams.get("cpu") ?? "0");
    const reqMemMi = Number(req.nextUrl.searchParams.get("mem") ?? "0");
    const fit = reqCpuM > 0 || reqMemMi > 0 ? { reqCpuM, reqMemMi, replicas: fitReplicas(headroom.nodes, reqCpuM, reqMemMi) } : null;

    return NextResponse.json({ ...headroom, fit, live: true });
  } catch {
    return NextResponse.json({ nodes: [], cluster: { allocatableCpuM: 0, allocatableMemMi: 0, freeCpuM: 0, freeMemMi: 0 }, fit: null, live: false });
  }
});
