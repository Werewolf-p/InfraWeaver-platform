import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export const POST = withRoute("cluster:admin", async (req, session) => {
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
    const customApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CustomObjectsApi);

    await customApi.patchNamespacedCustomObject({
      group: "cert-manager.io",
      version: "v1",
      namespace,
      plural: "certificates",
      name,
      body: { metadata: { annotations: { "cert-manager.io/issuer-name": issuerName ?? "letsencrypt-prod" } } },
    });

    await auditLog("security:renew-cert", session.user?.email ?? "unknown", `renew cert ${namespace}/${name}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
});
