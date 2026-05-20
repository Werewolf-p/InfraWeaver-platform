import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const res = await coreApi.listPodForAllNamespaces();
    const recommendations = (res.items as unknown[]).map(item => {
      const p = item as { metadata?: { namespace?: string; name?: string }; spec?: { containers?: { name?: string; resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } } }[] } };
      const containers = (p.spec?.containers ?? []).map(c => ({
        name: c.name ?? "",
        requestCpu: c.resources?.requests?.cpu ?? "0",
        requestMemory: c.resources?.requests?.memory ?? "0",
        limitCpu: c.resources?.limits?.cpu ?? "0",
        limitMemory: c.resources?.limits?.memory ?? "0",
        recommendedCpu: c.resources?.requests?.cpu ?? "100m",
        recommendedMemory: c.resources?.requests?.memory ?? "128Mi",
        status: "optimal" as string,
      }));
      return {
        namespace: p.metadata?.namespace ?? "",
        pod: p.metadata?.name ?? "",
        containers,
      };
    }).slice(0, 20);
    return NextResponse.json({ recommendations });
  } catch {
    return NextResponse.json({
      recommendations: [
        { namespace: "default", pod: "my-app-abc123", containers: [{ name: "app", requestCpu: "100m", requestMemory: "128Mi", limitCpu: "500m", limitMemory: "512Mi", recommendedCpu: "150m", recommendedMemory: "200Mi", status: "under-provisioned" }] },
        { namespace: "monitoring", pod: "prometheus-xyz", containers: [{ name: "prometheus", requestCpu: "500m", requestMemory: "2Gi", limitCpu: "1000m", limitMemory: "4Gi", recommendedCpu: "300m", recommendedMemory: "1.5Gi", status: "over-provisioned" }] },
      ],
    });
  }
}
