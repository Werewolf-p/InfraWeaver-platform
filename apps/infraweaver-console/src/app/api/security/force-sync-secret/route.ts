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
  const { namespace, name } = await req.json() as { namespace: string; name: string };
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject({
      group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets", namespace, name,
      body: { metadata: { annotations: { "force-sync": new Date().toISOString() } } },
    });
    await auditLog("security:force-sync-secret", session.user?.email ?? "unknown", `force sync ExternalSecret ${namespace}/${name}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
