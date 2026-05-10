import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications`, {
      headers: { Authorization: `Bearer ${ARGOCD_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error("ArgoCD unavailable");
    const data = await res.json() as { items?: Array<{ status: { health: { status: string }; sync: { status: string } } }> };
    const apps = data.items ?? [];
    const healthy = apps.filter(a => a.status.health.status === "Healthy").length;
    const degraded = apps.filter(a => a.status.health.status === "Degraded").length;
    const progressing = apps.filter(a => a.status.health.status === "Progressing").length;
    const outOfSync = apps.filter(a => a.status.sync.status === "OutOfSync").length;
    const total = apps.length;
    const overallStatus = degraded > 0 ? "degraded" : progressing > 0 ? "progressing" : "healthy";
    return NextResponse.json({ healthy, degraded, progressing, outOfSync, total, status: overallStatus });
  } catch {
    return NextResponse.json({ healthy: 0, degraded: 0, progressing: 0, outOfSync: 0, total: 0, status: "unknown" });
  }
}
