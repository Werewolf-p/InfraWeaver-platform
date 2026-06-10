import { NextResponse } from "next/server";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { getRequestClusterId } from "@/lib/cluster-context";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth(
  { permission: "apps:read" },
  async ({ req }) => {
    const clusterId = getRequestClusterId(req);
    const { apps, cacheStatus, dataSource } = await getArgocdAppsCached(clusterId);
    return NextResponse.json(apps, {
      headers: { "X-Cache": cacheStatus, "X-Data-Source": dataSource },
    });
  },
);
