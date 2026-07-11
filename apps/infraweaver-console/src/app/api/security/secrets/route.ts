import { X509Certificate } from "node:crypto";
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
    const secrets = tlsSecrets.map((item) => {
      const s = item as { metadata?: { namespace?: string; name?: string }; data?: Record<string, string> };
      let expiresAt: string | null = null;
      let daysLeft: number | null = null;
      let expired = false;
      const certB64 = s.data?.["tls.crt"];
      if (certB64) {
        try {
          const cert = new X509Certificate(Buffer.from(certB64, "base64"));
          const validTo = new Date(cert.validTo);
          expiresAt = validTo.toISOString();
          daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
          expired = validTo.getTime() <= Date.now();
        } catch {
          // Unparsable certificate payload — report unknown expiry rather than inventing one.
        }
      }
      return {
        namespace: s.metadata?.namespace ?? "",
        name: s.metadata?.name ?? "",
        expiresAt,
        daysLeft,
        expired,
      };
    });
    return NextResponse.json({ secrets });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
}
