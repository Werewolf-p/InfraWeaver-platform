import { NextRequest, NextResponse } from "next/server";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { getActiveClusterIdFromCookieValue, ACTIVE_CLUSTER_COOKIE } from "@/lib/cluster-context";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute("apps:read", async (request: NextRequest) => {
  const clusterId = getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value);
  const { apps, cacheStatus, dataSource } = await getArgocdAppsCached(clusterId);
  return NextResponse.json(apps, {
    headers: { "X-Cache": cacheStatus, "X-Data-Source": dataSource },
  });
});
