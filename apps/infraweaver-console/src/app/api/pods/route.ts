import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const namespace = req.nextUrl.searchParams.get("namespace") ?? undefined;
  const mockPods = [
    { name: "argocd-server-abc123", namespace: "argocd", status: "Running", containers: ["argocd-server"], nodeName: "node-1", createdAt: new Date().toISOString() },
    { name: "argocd-repo-server-def456", namespace: "argocd", status: "Running", containers: ["argocd-repo-server", "cmp-plugin"], nodeName: "node-1", createdAt: new Date().toISOString() },
    { name: "wiki-js-789abc", namespace: "wiki", status: "Running", containers: ["wiki"], nodeName: "node-2", createdAt: new Date().toISOString() },
    { name: "gatus-def123", namespace: "monitoring", status: "Running", containers: ["gatus"], nodeName: "node-1", createdAt: new Date().toISOString() },
    { name: "longhorn-manager-xyz", namespace: "longhorn-system", status: "Running", containers: ["longhorn-manager"], nodeName: "node-2", createdAt: new Date().toISOString() },
    { name: "netbird-abc789", namespace: "netbird", status: "Running", containers: ["management", "signal"], nodeName: "node-1", createdAt: new Date().toISOString() },
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
        status?: { phase?: string };
      };
      return {
        name: p.metadata?.name ?? "",
        namespace: p.metadata?.namespace ?? "",
        status: p.status?.phase ?? "Unknown",
        containers: (p.spec?.containers ?? []).map((c) => c.name),
        nodeName: p.spec?.nodeName ?? "",
        createdAt: p.metadata?.creationTimestamp?.toISOString() ?? "",
      };
    });
    const filtered = namespace ? pods.filter(p => p.namespace === namespace) : pods;
    return NextResponse.json(filtered);
  } catch {
    const filtered = namespace ? mockPods.filter(p => p.namespace === namespace) : mockPods;
    return NextResponse.json(filtered);
  }
}
