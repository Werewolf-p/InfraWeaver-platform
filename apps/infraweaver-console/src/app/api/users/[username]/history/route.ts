import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { authentikFetch } from "@/lib/authentik";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:read", "users:write", "users:invite", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;
  const r = await authentikFetch(
    `/events/events/?user=${encodeURIComponent(username)}&action=login&page_size=50`
  );
  if (!r.ok) return NextResponse.json({ events: [] });
  const data = await r.json();
  return NextResponse.json({ events: data.results ?? [] });
}
