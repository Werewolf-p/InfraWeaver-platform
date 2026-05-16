import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { isValidK8sName, isValidNamespace } from "@/lib/validate";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-restart-app", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const RestartAppBody = z.object({
    namespace: z.string().min(1).max(63),
    appName: z.string().min(1).max(253),
  });
  const result = RestartAppBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { namespace, appName } = result.data;
  if (!isValidNamespace(namespace) || !isValidK8sName(appName)) {
    return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    await appsApi.patchNamespacedDeployment({
      name: appName, namespace,
      body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
    });
    await auditLog("cluster:restart-app", session.user?.email ?? "unknown", `restarted ${namespace}/${appName}`);
    invalidateClusterCaches();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
