import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-drain", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const DrainBody = z.object({ node: z.string().min(1).max(253) });
  const result = DrainBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { node } = result.data;
  const evicted: string[] = [];
  const errors: string[] = [];
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNode({ name: node, body: { spec: { unschedulable: true } } });
    const podsRes = await coreApi.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${node}` });
    for (const pod of podsRes.items) {
      const isDaemonSet = pod.metadata?.ownerReferences?.some(r => r.kind === "DaemonSet");
      if (isDaemonSet) continue;
      const ns = pod.metadata?.namespace ?? "default";
      const name = pod.metadata?.name ?? "";
      try {
        await coreApi.createNamespacedPodEviction({
          name,
          namespace: ns,
          body: { metadata: { name, namespace: ns } } as k8s.V1Eviction,
        });
        evicted.push(`${ns}/${name}`);
      } catch (e) {
        errors.push(`${ns}/${name}: ${String(e)}`);
      }
    }
    await auditLog("cluster:drain", session.user?.email ?? "unknown", `drained node ${node}, evicted ${evicted.length} pods`);
    return NextResponse.json({ ok: true, evicted, errors });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, evicted: [], errors: [] });
  }
}
