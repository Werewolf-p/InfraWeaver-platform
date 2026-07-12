import { NextResponse } from "next/server";
import * as k8s from "@kubernetes/client-node";
import { auditLog } from "@/lib/audit-log";
import { makeCoreApi } from "@/lib/kube-client";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { requireSingleCluster } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "cluster-drain", limit: 3, windowMs: 60_000 } },
  async ({ req, session }) => {
    const result = z.object({ node: z.string().min(1).max(253) }).safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

    const { node } = result.data;
    const evicted: string[] = [];
    const errors: string[] = [];

    const cluster = requireSingleCluster(req);
    if (cluster instanceof NextResponse) return cluster;

    try {
      const coreApi = makeCoreApi(cluster.clusterId);
      await coreApi.patchNode({ name: node, body: { spec: { unschedulable: true } } });
      const podsRes = await coreApi.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${node}` });
      for (const pod of podsRes.items) {
        if (pod.metadata?.ownerReferences?.some((owner) => owner.kind === "DaemonSet")) continue;
        const namespace = pod.metadata?.namespace ?? "default";
        const name = pod.metadata?.name ?? "";
        try {
          await coreApi.createNamespacedPodEviction({ name, namespace, body: { metadata: { name, namespace } } as k8s.V1Eviction });
          evicted.push(`${namespace}/${name}`);
        } catch (error) {
          errors.push(`${namespace}/${name}: ${safeError(error)}`);
        }
      }
      await auditLog("cluster:drain", session.user?.email ?? "unknown", `drained node ${node}, evicted ${evicted.length} pods`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true, evicted, errors });
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
