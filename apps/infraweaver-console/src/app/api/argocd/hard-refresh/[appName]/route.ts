import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { invalidateArgocdCaches } from "@/lib/performance-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { isValidK8sName } from "@/lib/validate";

export async function POST(req: NextRequest, { params }: { params: Promise<{ appName: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:sync")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("argocd-hard-refresh", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { appName } = await params;
  if (!isValidK8sName(appName)) return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  const server = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local";
  const token = process.env.ARGOCD_TOKEN ?? "";
  try {
    const res = await fetch(`${server}/api/v1/applications/${appName}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hardRefresh: true }),
    });
    if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
    await auditLog("argocd:hard-refresh", session.user?.email ?? "unknown", `hard refresh ${appName}`);
    invalidateArgocdCaches();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
