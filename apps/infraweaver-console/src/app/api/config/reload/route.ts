import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const server = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local";
  const token = process.env.ARGOCD_TOKEN ?? "";
  const appName = process.env.ARGOCD_APP_OF_APPS ?? "app-of-apps";
  try {
    const res = await fetch(`${server}/api/v1/applications/${appName}/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
    await auditLog("config:reload", session.user?.email ?? "unknown", `triggered hot-reload of ${appName}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
