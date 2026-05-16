import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { getActiveClusterIdFromCookieValue, ACTIVE_CLUSTER_COOKIE } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const clusterId = getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value);
  const { apps, cacheStatus, dataSource } = await getArgocdAppsCached(clusterId);
  return NextResponse.json(apps, {
    headers: { "X-Cache": cacheStatus, "X-Data-Source": dataSource },
  });
}
