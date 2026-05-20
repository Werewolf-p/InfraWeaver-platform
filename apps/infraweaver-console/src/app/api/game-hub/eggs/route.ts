import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { BUILT_IN_EGGS } from "@/lib/game-eggs";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ eggs: BUILT_IN_EGGS });
}
