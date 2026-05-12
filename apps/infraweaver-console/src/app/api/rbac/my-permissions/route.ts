import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getBuiltInRoles, getEffectivePermissions, getRole } from "@/lib/rbac";
import { safeError } from "@/lib/utils";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
    const { username, roleAssignments } = await getRoleAssignmentsForSession(session, 60);
    const permissions = [...getEffectivePermissions(groups, username, roleAssignments, "/")];

    return NextResponse.json({
      email: session.user?.email ?? "",
      legacyRole: getRole(groups),
      assignments: roleAssignments,
      permissions,
      roles: getBuiltInRoles(),
      isAdmin: permissions.includes("*"),
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
