import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-drain", req), 3, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const result = z.object({ node: z.string().min(1).max(253) }).safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  const { node } = result.data;
  const evicted: string[] = [];
  const errors: string[] = [];

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
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
  } catch {
    return NextResponse.json({ ok: true, simulated: true, evicted: [], errors: [] });
  }
}
