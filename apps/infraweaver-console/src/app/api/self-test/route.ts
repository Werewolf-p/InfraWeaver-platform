import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getRequestClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import * as k8s from "@kubernetes/client-node";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "infra:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const kc = loadKubeConfig(getRequestClusterId(request));
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    const [podsData, nodesData, deploymentsData] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNode(),
      appsApi.listDeploymentForAllNamespaces(),
    ]);

    return NextResponse.json({
      healthy: true,
      podCount: podsData.items?.length ?? 0,
      appCount: deploymentsData.items?.length ?? 0,
      nodeCount: nodesData.items?.length ?? 0,
      testedAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({
      healthy: false,
      error: safeError(err),
    });
  }
}
