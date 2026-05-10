import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import * as k8s from "@kubernetes/client-node";

function makeKc() {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
  return kc;
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { namespace, deployment, replicas } = await req.json() as { namespace: string; deployment: string; replicas: number };
  if (typeof replicas !== "number" || replicas < 0 || replicas > 20) return NextResponse.json({ error: "replicas must be 0-20" }, { status: 400 });
  try {
    const appsApi = makeKc().makeApiClient(k8s.AppsV1Api);
    await appsApi.patchNamespacedDeployment({ name: deployment, namespace, body: { spec: { replicas } } });
    await auditLog("cluster:scale", session.user?.email ?? "unknown", `scaled ${namespace}/${deployment} to ${replicas}`);
    return NextResponse.json({ ok: true, replicas });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, replicas });
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const namespace = searchParams.get("namespace") ?? "";
  const deployment = searchParams.get("deployment") ?? "";
  if (!namespace || !deployment) return NextResponse.json({ error: "namespace and deployment required" }, { status: 400 });
  try {
    const appsApi = makeKc().makeApiClient(k8s.AppsV1Api);
    const dep = await appsApi.readNamespacedDeployment({ name: deployment, namespace });
    return NextResponse.json({ replicas: dep.spec?.replicas ?? 1 });
  } catch {
    return NextResponse.json({ replicas: 1, simulated: true });
  }
}
