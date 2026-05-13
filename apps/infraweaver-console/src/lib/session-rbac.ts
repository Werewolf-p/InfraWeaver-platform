import type { Session } from "next-auth";
import {
  hasAssignedPermissionForScope,
  hasPermission,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export interface SessionRBACContext {
  groups: string[];
  username: string;
  roleAssignments: RoleAssignment[];
}

export async function getSessionRBACContext(
  session: Session | null,
  revalidateSeconds = 60,
): Promise<SessionRBACContext> {
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const { username, roleAssignments } = await getRoleAssignmentsForSession(session, revalidateSeconds);
  return { groups, username, roleAssignments };
}

export function hasSessionPermission(
  context: SessionRBACContext,
  permission: Permission,
  scope = "/",
) {
  return hasPermission(
    context.groups,
    permission,
    context.roleAssignments,
    scope,
    context.username,
  );
}

export function hasAnySessionPermission(
  context: SessionRBACContext,
  permissions: Permission[],
  scope = "/",
) {
  return permissions.some((permission) => hasSessionPermission(context, permission, scope));
}

export function hasAssignedSessionPermission(
  context: SessionRBACContext,
  permission: Permission,
  scope: string,
) {
  return hasAssignedPermissionForScope(context.roleAssignments, permission, scope);
}
