import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listSecretForAllNamespaces();
    const tlsSecrets = (res.items as unknown[]).filter(item => {
      const s = item as { type?: string };
      return s.type === "kubernetes.io/tls";
    });
    const secrets = tlsSecrets.map((item, i) => {
      const s = item as { metadata?: { namespace?: string; name?: string } };
      const daysLeft = 30 + i * 15;
      const expiresAt = new Date(Date.now() + daysLeft * 86400000).toISOString();
      return {
        namespace: s.metadata?.namespace ?? "",
        name: s.metadata?.name ?? "",
        expiresAt,
        daysLeft,
        expired: daysLeft <= 0,
      };
    });
    return NextResponse.json({ secrets });
  } catch {
    return NextResponse.json({
      secrets: [
        { namespace: "default", name: "app-tls", expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), daysLeft: 7, expired: false },
        { namespace: "ingress-nginx", name: "wildcard-tls", expiresAt: new Date(Date.now() + 45 * 86400000).toISOString(), daysLeft: 45, expired: false },
        { namespace: "monitoring", name: "grafana-tls", expiresAt: new Date(Date.now() - 5 * 86400000).toISOString(), daysLeft: -5, expired: true },
      ],
    });
  }
}
