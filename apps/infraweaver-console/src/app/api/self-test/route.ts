import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { makeAppsApi, makeCoreApi } from "@/lib/kube-client";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "infra:read" }, async ({ req }) => {
  try {
    const clusterId = getRequestClusterId(req);
    const coreApi = makeCoreApi(clusterId);

    const [podsData, nodesData, deploymentsData] = await Promise.all([
      coreApi.listPodForAllNamespaces(),
      coreApi.listNode(),
      makeAppsApi(clusterId).listDeploymentForAllNamespaces(),
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
});
