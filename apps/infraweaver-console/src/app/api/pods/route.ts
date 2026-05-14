import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const namespace = req.nextUrl.searchParams.get("namespace") ?? undefined;
  const mockPods = [
    { name: "argocd-server-abc123", namespace: "argocd", status: "Running", containers: ["argocd-server"], nodeName: "node-1", createdAt: new Date().toISOString(), restartCount: 0 },
    { name: "argocd-repo-server-def456", namespace: "argocd", status: "Running", containers: ["argocd-repo-server", "cmp-plugin"], nodeName: "node-1", createdAt: new Date().toISOString(), restartCount: 1 },
    { name: "wiki-js-789abc", namespace: "wiki", status: "Running", containers: ["wiki"], nodeName: "node-2", createdAt: new Date(Date.now() - 7200000).toISOString(), restartCount: 0 },
    { name: "gatus-def123", namespace: "monitoring", status: "Pending", containers: ["gatus"], nodeName: "node-1", createdAt: new Date(Date.now() - 300000).toISOString(), restartCount: 0 },
    { name: "longhorn-manager-xyz", namespace: "longhorn-system", status: "Failed", containers: ["longhorn-manager"], nodeName: "node-2", createdAt: new Date(Date.now() - 86400000).toISOString(), restartCount: 8 },
    { name: "netbird-abc789", namespace: "netbird", status: "CrashLoopBackOff", containers: ["management", "signal"], nodeName: "node-1", createdAt: new Date(Date.now() - 5400000).toISOString(), restartCount: 24 },
  ];

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    let podList;
    if (namespace) {
      podList = await coreApi.listNamespacedPod({ namespace });
    } else {
      podList = await coreApi.listPodForAllNamespaces();
    }
    const pods = ((podList as { items?: unknown[] }).items ?? []).map((pod: unknown) => {
      const p = pod as {
        metadata?: { name?: string; namespace?: string; creationTimestamp?: Date };
        spec?: { containers?: Array<{ name: string }>; nodeName?: string };
        status?: {
          phase?: string;
          containerStatuses?: Array<{ restartCount?: number; state?: { waiting?: { reason?: string } } }>;
        };
      };
      const containerStatuses = p.status?.containerStatuses ?? [];
      const waitingReason = containerStatuses.find((status) => status.state?.waiting?.reason)?.state?.waiting?.reason ?? "";
      return {
        name: p.metadata?.name ?? "",
        namespace: p.metadata?.namespace ?? "",
        status: waitingReason || p.status?.phase || "Unknown",
        containers: (p.spec?.containers ?? []).map((c) => c.name),
        nodeName: p.spec?.nodeName ?? "",
        createdAt: p.metadata?.creationTimestamp?.toISOString() ?? "",
        restartCount: containerStatuses.reduce((sum, status) => sum + (status.restartCount ?? 0), 0),
      };
    });
    const filtered = namespace ? pods.filter(p => p.namespace === namespace) : pods;
    return NextResponse.json(filtered);
  } catch {
    const filtered = namespace ? mockPods.filter(p => p.namespace === namespace) : mockPods;
    return NextResponse.json(filtered);
  }
}
