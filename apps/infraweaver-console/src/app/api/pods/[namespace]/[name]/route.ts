import { NextRequest, NextResponse } from "next/server";
import { dump } from "js-yaml";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { validateK8sName, validateK8sNamespace } from "@/lib/api-security";
import { getRequestClusterId } from "@/lib/cluster-context";
import { makeCoreApi } from "@/lib/kube-client";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { logMutatingAccess } from "@/lib/access-log";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { requireSingleCluster } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";
import { restartPodSafely } from "../../restart-pod";

function serializeYaml(value: unknown) {
  return dump(JSON.parse(JSON.stringify(value)), { noRefs: true, lineWidth: 120 });
}

export const GET = withAuth<{ namespace: string; name: string }>(
  { permission: ["cluster:read", "infra:read"] },
  async ({ req, params }) => {
  const { namespace, name } = params;
  const namespaceErr = validateK8sNamespace(namespace);
  if (namespaceErr) return NextResponse.json(namespaceErr.error, { status: namespaceErr.status });
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  try {
    const pod = await makeCoreApi(getRequestClusterId(req)).readNamespacedPod({ name, namespace });
    const statuses = pod.status?.containerStatuses ?? [];

    return NextResponse.json({
      name: pod.metadata?.name ?? name,
      namespace: pod.metadata?.namespace ?? namespace,
      status: pod.status?.phase ?? "Unknown",
      nodeName: pod.spec?.nodeName ?? "",
      podIP: pod.status?.podIP ?? "",
      createdAt: pod.metadata?.creationTimestamp?.toISOString() ?? "",
      labels: pod.metadata?.labels ?? {},
      containers: (pod.spec?.containers ?? []).map((container) => {
        const status = statuses.find((entry) => entry.name === container.name);
        return {
          name: container.name,
          image: container.image ?? "",
          ready: status?.ready ?? false,
          restartCount: status?.restartCount ?? 0,
          requests: (container.resources?.requests as Record<string, string> | undefined) ?? {},
          limits: (container.resources?.limits as Record<string, string> | undefined) ?? {},
        };
      }),
      yaml: serializeYaml(pod),
    });
  } catch {
    return NextResponse.json({ error: "Kubernetes unavailable" }, { status: 503 });
  }
});

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ namespace: string; name: string }> }) {
  const session = await auth();
  const actor = session?.user?.email ?? "unauthenticated";
  if (!session) {
    logMutatingAccess(req, actor, { status: 401 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    logMutatingAccess(req, actor, { status: 403 });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  logMutatingAccess(req, actor);
  if (!checkRateLimit(rateLimitKey("pod-delete", req), 10, 60_000)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  const { namespace, name } = await params;
  const namespaceErr = validateK8sNamespace(namespace);
  if (namespaceErr) return NextResponse.json(namespaceErr.error, { status: namespaceErr.status });
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const force = new URL(req.url).searchParams.get("force") === "true";
  try {
    const cluster = requireSingleCluster(req);
    if (cluster instanceof NextResponse) return cluster;
    const coreApi = makeCoreApi(cluster.clusterId);

    // Refuse to delete a pod mid-install unless forced: a deliberate operator
    // delete passes ?force=true.
    const outcome = await restartPodSafely(coreApi, { namespace, name }, force);
    if (outcome === "skipped-installing") {
      return NextResponse.json(
        { error: "Pod is still installing; refusing to delete. Retry with ?force=true to override.", skippedInstalling: true },
        { status: 409 },
      );
    }
    await auditLog("pod:delete", session.user?.email ?? "unknown", `deleted pod ${namespace}/${name}${force ? " (forced)" : ""}`);
    invalidatePodCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete pod" }, { status: 502 });
  }
}
