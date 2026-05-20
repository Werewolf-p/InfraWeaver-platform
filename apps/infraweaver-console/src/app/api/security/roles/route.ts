import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { getBuiltInRoles } from "@/lib/rbac";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "security:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ roles: getBuiltInRoles() });
}
