import { X509Certificate } from "node:crypto";
import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { listItems } from "@/lib/kube-client";
import { withRoute } from "@/lib/route-utils";
import * as k8s from "@kubernetes/client-node";

export const GET = withRoute("security:read", async (req) => {
  try {
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listSecretForAllNamespaces();
    const tlsSecrets = listItems<{
      type?: string;
      metadata?: { namespace?: string; name?: string };
      data?: Record<string, string>;
    }>(res).filter((s) => s.type === "kubernetes.io/tls");
    const secrets = tlsSecrets.map((s) => {
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
});
