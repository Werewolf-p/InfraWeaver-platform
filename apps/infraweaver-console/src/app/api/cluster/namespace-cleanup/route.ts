import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("namespace-cleanup", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { namespace } = await req.json() as { namespace: string };
  const deleted: string[] = [];
  const errors: string[] = [];
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace });
    for (const pod of pods.items) {
      const name = pod.metadata?.name ?? "";
      const reason = pod.status?.reason;
      const phase = pod.status?.phase;
      const isTerminating = pod.metadata?.deletionTimestamp != null && (pod.metadata.finalizers?.length ?? 0) > 0;
      if (reason === "Evicted" || phase === "Failed") {
        try { await coreApi.deleteNamespacedPod({ name, namespace }); deleted.push(`pod/${name}`); } catch (e) { errors.push(`pod/${name}: ${String(e)}`); }
      } else if (isTerminating) {
        try {
          await coreApi.patchNamespacedPod({ name, namespace, body: { metadata: { finalizers: [] } } });
          deleted.push(`pod/${name} (finalizers removed)`);
        } catch (e) { errors.push(`pod/${name}: ${String(e)}`); }
      }
    }
    const jobs = await batchApi.listNamespacedJob({ namespace });
    for (const job of jobs.items) {
      const name = job.metadata?.name ?? "";
      const succeeded = job.status?.succeeded ?? 0;
      const failed = job.status?.failed ?? 0;
      const active = job.status?.active ?? 0;
      if (active === 0 && (succeeded > 0 || failed > 0)) {
        try { await batchApi.deleteNamespacedJob({ name, namespace }); deleted.push(`job/${name}`); } catch (e) { errors.push(`job/${name}: ${String(e)}`); }
      }
    }
    await auditLog("cluster:namespace-cleanup", session.user?.email ?? "unknown", `cleaned up ${namespace}: deleted ${deleted.length} resources`);
    return NextResponse.json({ ok: true, deleted, errors });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, deleted: [], errors: [] });
  }
}
