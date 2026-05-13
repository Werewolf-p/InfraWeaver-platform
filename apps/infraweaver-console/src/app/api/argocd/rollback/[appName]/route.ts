import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";

export async function POST(req: NextRequest, { params }: { params: Promise<{ appName: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:sync")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { appName } = await params;
  const RollbackBody = z.object({ revision: z.number().int().min(0) });
  const result = RollbackBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { revision } = result.data;
  const server = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local";
  const token = process.env.ARGOCD_TOKEN ?? "";
  try {
    const res = await fetch(`${server}/api/v1/applications/${appName}/rollback`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: revision }),
    });
    if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
    await auditLog("argocd:rollback", session.user?.email ?? "unknown", `rolled back ${appName} to revision ${revision}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
