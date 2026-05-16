import { NextRequest, NextResponse } from "next/server";
import { dump } from "js-yaml";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { validateK8sName, validateK8sNamespace } from "@/lib/api-security";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { invalidatePodCaches } from "@/lib/performance-cache";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import * as k8s from "@kubernetes/client-node";

function serializeYaml(value: unknown) {
  return dump(JSON.parse(JSON.stringify(value)), { noRefs: true, lineWidth: 120 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ namespace: string; name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { namespace, name } = await params;
  const namespaceErr = validateK8sNamespace(namespace);
  if (namespaceErr) return NextResponse.json(namespaceErr.error, { status: namespaceErr.status });
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  try {
    const coreApi = loadKubeConfig(getRequestClusterId(req)).makeApiClient(k8s.CoreV1Api);
    const pod = await coreApi.readNamespacedPod({ name, namespace });
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
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ namespace: string; name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("pod-delete", req), 10, 60_000)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  const { namespace, name } = await params;
  const namespaceErr = validateK8sNamespace(namespace);
  if (namespaceErr) return NextResponse.json(namespaceErr.error, { status: namespaceErr.status });
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  try {
    const clusterId = getRequestClusterId(req);
    if (clusterId === "all") {
      return NextResponse.json({ error: "Select a specific cluster before performing this action" }, { status: 400 });
    }
    const coreApi = loadKubeConfig(clusterId).makeApiClient(k8s.CoreV1Api);
    await coreApi.deleteNamespacedPod({ name, namespace });
    await auditLog("pod:delete", session.user?.email ?? "unknown", `deleted pod ${namespace}/${name}`);
    invalidatePodCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete pod" }, { status: 502 });
  }
}
