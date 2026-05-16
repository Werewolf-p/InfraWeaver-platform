import { NextRequest, NextResponse } from "next/server";
import { getArgocdAppsCached } from "@/lib/argocd-apps";
import { requireRoutePermissions } from "@/lib/route-utils";
import { getRequestClusterId } from "@/lib/cluster-context";

export async function GET(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["apps:read"] });
  if (session instanceof NextResponse) return session;

  try {
    const clusterId = getRequestClusterId(request);
    const { apps } = await getArgocdAppsCached(clusterId);
    const healthy = apps.filter(a => a.status?.health?.status === "Healthy").length;
    const degraded = apps.filter(a => a.status?.health?.status === "Degraded").length;
    const progressing = apps.filter(a => a.status?.health?.status === "Progressing").length;
    const outOfSync = apps.filter(a => a.status?.sync?.status === "OutOfSync").length;
    const total = apps.length;
    const overallStatus = total === 0 ? "unknown" : degraded > 0 ? "degraded" : progressing > 0 ? "progressing" : "healthy";
    return NextResponse.json({ healthy, degraded, progressing, outOfSync, total, status: overallStatus });
  } catch {
    return NextResponse.json({ healthy: 0, degraded: 0, progressing: 0, outOfSync: 0, total: 0, status: "unknown" });
  }
}
