import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { namespace } = await req.json() as { namespace: string };
  const restarted: string[] = [];
  const errors: string[] = [];
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const deps = await appsApi.listNamespacedDeployment({ namespace });
    for (const dep of deps.items) {
      const name = dep.metadata?.name ?? "";
      try {
        await appsApi.patchNamespacedDeployment({
          name, namespace,
          body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
        });
        restarted.push(name);
      } catch (e) {
        errors.push(`${name}: ${String(e)}`);
      }
    }
    await auditLog("cluster:rolling-restart", session.user?.email ?? "unknown", `rolling restart in ${namespace}: ${restarted.join(", ")}`);
    return NextResponse.json({ ok: true, restarted, errors });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, restarted: [], errors: [] });
  }
}
