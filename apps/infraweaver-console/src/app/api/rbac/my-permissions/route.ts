import { getBuiltInRoles, getEffectivePermissions, getRole } from "@/lib/rbac";
import { apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export async function GET() {
  const session = await requireRoutePermissions();
  if (session instanceof Response) return session;

  try {
    const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
    const { username, roleAssignments } = await getRoleAssignmentsForSession(session, 60);
    const permissions = [...getEffectivePermissions(groups, username, roleAssignments, "/")];

    return apiSuccess({
      email: session.user?.email ?? "",
      legacyRole: getRole(groups),
      assignments: roleAssignments,
      permissions,
      roles: getBuiltInRoles(),
      isAdmin: permissions.includes("*"),
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
