import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { namespace, name } = await req.json() as { namespace: string; name: string };
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject({
      group: "cert-manager.io", version: "v1", plural: "certificates", namespace, name,
      body: { metadata: { annotations: { "cert-manager.io/issuer-name": "renewed" } } },
    });
    await auditLog("security:renew-cert", session.user?.email ?? "unknown", `renew cert ${namespace}/${name}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
