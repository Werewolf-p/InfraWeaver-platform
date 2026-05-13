import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const { ip } = await res.json() as { ip: string };
    return NextResponse.json({ ip });
  } catch {
    return NextResponse.json({ error: "Failed to detect IP" }, { status: 500 });
  }
}
