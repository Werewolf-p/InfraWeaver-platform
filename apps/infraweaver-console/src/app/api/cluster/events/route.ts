import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { loadClusterEvents } from "@/lib/ops-data";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["apps:read", "cluster:read", "infra:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(await loadClusterEvents(), {
    headers: { "Cache-Control": "no-store" },
  });
}
