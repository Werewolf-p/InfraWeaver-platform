import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { authentikFetch, findUserByUsername, mapAuthentikSessions } from "@/lib/authentik";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { z } from "zod";

const SessionParams = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
});

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

  const parsedParams = SessionParams.safeParse(await params);
  if (!parsedParams.success) return NextResponse.json({ error: "Invalid username" }, { status: 400 });

  const user = await findUserByUsername(parsedParams.data.username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const r = await authentikFetch(`/core/tokens/?user=${encodeURIComponent(parsedParams.data.username)}&page_size=20`);
  if (!r.ok) return NextResponse.json({ sessions: [] });
  const data = await r.json() as { results?: unknown[] };
  return NextResponse.json({ sessions: mapAuthentikSessions(data.results ?? []) });
}
