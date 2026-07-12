import { NextRequest, NextResponse } from "next/server";
import { getArgocdAppsCached, summarizeArgoAppHealth } from "@/lib/argocd-apps";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["apps:read"] });
  if (session instanceof NextResponse) return session;

  try {
    const { apps } = await getArgocdAppsCached(getRequestClusterId(request));
    const summary = summarizeArgoAppHealth(apps);
    const overallStatus = summary.total === 0 ? "unknown" : summary.degraded > 0 ? "degraded" : summary.progressing > 0 ? "progressing" : "healthy";
    return NextResponse.json({ ...summary, status: overallStatus });
  } catch {
    return NextResponse.json({ healthy: 0, degraded: 0, progressing: 0, outOfSync: 0, total: 0, status: "unknown" });
  }
}
