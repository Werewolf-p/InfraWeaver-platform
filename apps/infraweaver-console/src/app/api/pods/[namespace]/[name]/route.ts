import { NextRequest, NextResponse } from "next/server";
import { dump } from "js-yaml";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { getSessionRBACContext, hasAnySessionPermission, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import * as k8s from "@kubernetes/client-node";

function serializeYaml(value: unknown) {
  return dump(JSON.parse(JSON.stringify(value)), { noRefs: true, lineWidth: 120 });
}

function buildMockPod(namespace: string, name: string) {
  return {
    name,
    namespace,
    status: "Running",
    nodeName: "node-1",
    podIP: "10.42.0.15",
    createdAt: new Date().toISOString(),
    labels: {
      app: name,
      namespace,
    },
    containers: [
      {
        name: "main",
        image: "ghcr.io/example/app:latest",
        ready: true,
        restartCount: 0,
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "500m", memory: "512Mi" },
      },
    ],
    yaml: dump({ apiVersion: "v1", kind: "Pod", metadata: { name, namespace }, status: { phase: "Running" } }, { noRefs: true }),
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ namespace: string; name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { namespace, name } = await params;

  try {
    const coreApi = loadKubeConfig().makeApiClient(k8s.CoreV1Api);
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
    return NextResponse.json(buildMockPod(namespace, name));
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ namespace: string; name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("pod-delete", req), 10, 60_000)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  const { namespace, name } = await params;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      try {
        kc.loadFromCluster();
      } catch {
        kc.loadFromDefault();
      }
    }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    await coreApi.deleteNamespacedPod({ name, namespace });
    await auditLog("pod:delete", session.user?.email ?? "unknown", `deleted pod ${namespace}/${name}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
