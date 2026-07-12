import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export const POST = withRoute("cluster:admin", async (req, session) => {
  if (!checkRateLimit(rateLimitKey("force-sync-secret", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const ForceSyncBody = z.object({
    namespace: z.string().min(1).max(63),
    name: z.string().min(1).max(253),
  });
  const result = ForceSyncBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { namespace, name } = result.data;
  try {
    const customApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject({
      group: "external-secrets.io", version: "v1beta1", plural: "externalsecrets", namespace, name,
      body: { metadata: { annotations: { "force-sync": new Date().toISOString() } } },
    });
    await auditLog("security:force-sync-secret", session.user?.email ?? "unknown", `force sync ExternalSecret ${namespace}/${name}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
});
