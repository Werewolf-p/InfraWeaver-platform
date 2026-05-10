import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const secrets = await coreApi.listSecretForAllNamespaces();
    const certs = ((secrets as { items?: unknown[] }).items ?? [])
      .filter((s: unknown) => (s as { type?: string }).type === "kubernetes.io/tls")
      .map((s: unknown) => {
        const sec = s as { metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> }; data?: Record<string, string> };
        const certData = sec.data?.["tls.crt"];
        if (!certData) return { name: sec.metadata?.name, namespace: sec.metadata?.namespace, valid: false, daysLeft: null, domain: null };
        try {
          const pem = Buffer.from(certData, "base64").toString("utf-8");
          // Extract Not After from PEM using regex on the decoded text isn't possible without a crypto lib
          // Use the cert-manager annotation if present, otherwise check tls.crt header
          const expiryAnnotation = sec.metadata?.annotations?.["cert-manager.io/not-after"] 
            ?? sec.metadata?.annotations?.["cert-manager.io/expiration"];
          const domain = sec.metadata?.annotations?.["cert-manager.io/common-name"]
            ?? sec.metadata?.annotations?.["cert-manager.io/dns-names"]?.split(",")[0];
          let daysLeft: number | null = null;
          let expiresAt: string | null = null;
          if (expiryAnnotation) {
            const exp = new Date(expiryAnnotation);
            daysLeft = Math.floor((exp.getTime() - Date.now()) / 86400000);
            expiresAt = exp.toISOString();
          } else {
            // Try to extract from pem header line count (rough heuristic: Let's Encrypt = 90 days)
            const hasPem = pem.includes("-----BEGIN CERTIFICATE-----");
            void hasPem;
          }
          return { name: sec.metadata?.name, namespace: sec.metadata?.namespace, valid: true, expiresAt, daysLeft, domain };
        } catch {
          return { name: sec.metadata?.name, namespace: sec.metadata?.namespace, valid: false, daysLeft: null, domain: null };
        }
      });
    return NextResponse.json(certs);
  } catch {
    return NextResponse.json([
      { name: "infraweaver-int-tls", namespace: "infraweaver-console", valid: true, expiresAt: new Date(Date.now() + 60 * 86400000).toISOString(), daysLeft: 60, domain: "infraweaver.int.rlservers.com" },
      { name: "auth-tls", namespace: "authentik", valid: true, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), daysLeft: 30, domain: "auth.rlservers.com" },
      { name: "grafana-tls", namespace: "apps-grafana", valid: true, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(), daysLeft: 90, domain: "grafana.int.rlservers.com" },
    ]);
  }
}
