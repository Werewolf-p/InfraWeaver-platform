import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-rolling-restart", req), 3, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const result = z.object({ namespace: z.string().min(1).max(63) }).safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  const { namespace } = result.data;
  const restarted: string[] = [];
  const errors: string[] = [];

  const clusterId = getRequestClusterId(req);
  if (clusterId === "all") {
    return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
  }

  try {
    const appsApi = loadKubeConfig(clusterId).makeApiClient(k8s.AppsV1Api);
    const deployments = await appsApi.listNamespacedDeployment({ namespace });
    for (const deployment of deployments.items) {
      const name = deployment.metadata?.name ?? "";
      try {
        await appsApi.patchNamespacedDeployment({
          name,
          namespace,
          body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
        });
        restarted.push(name);
      } catch (error) {
        errors.push(`${name}: ${safeError(error)}`);
      }
    }
    await auditLog("cluster:rolling-restart", session.user?.email ?? "unknown", `rolling restart in ${namespace}: ${restarted.join(", ")}`);
    invalidateClusterCaches();
    return NextResponse.json({ ok: true, restarted, errors });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
}
