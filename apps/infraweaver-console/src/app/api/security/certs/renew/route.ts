import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";
import { withRoute } from "@/lib/route-utils";

export const POST = withRoute("cluster:admin", async (req: NextRequest) => {
  if (!checkRateLimit(rateLimitKey("certs-renew", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const CertsRenewBody = z.object({
    namespace: z.string().min(1).max(63),
    name: z.string().min(1).max(253),
    issuerName: z.string().min(1).max(253),
  });
  const result = CertsRenewBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { namespace, name, issuerName } = result.data;

  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    }
    const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
    
    await customApi.patchNamespacedCustomObject({
      group: "cert-manager.io",
      version: "v1",
      namespace,
      plural: "certificates",
      name,
      body: { metadata: { annotations: { "cert-manager.io/issuer-name": issuerName ?? "letsencrypt-prod" } } },
    });
    
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
});
