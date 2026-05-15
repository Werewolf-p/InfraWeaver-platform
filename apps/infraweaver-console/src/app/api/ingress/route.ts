import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { loadIngressRoutes } from "@/lib/ops-data";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["infra:read", "cluster:read", "security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(await loadIngressRoutes(), {
    headers: { "Cache-Control": "no-store" },
  });
}
