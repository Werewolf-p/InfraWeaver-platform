import { NextResponse } from "next/server";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getClusterConfigs } from "@/lib/cluster-context";

export async function GET() {
  const session = await requireRoutePermissions({ all: ["cluster:read"] });
  if (session instanceof NextResponse) return session;

  return NextResponse.json({
    clusters: getClusterConfigs().map((cluster) => ({
      id: cluster.id,
      displayName: cluster.displayName,
    })),
  });
}
