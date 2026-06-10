import type { Session } from "next-auth";
import {
  getEffectivePermissions,
  hasAssignedPermissionForScope,
  hasPermission,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";
import { getAccessState } from "@/lib/access-store";
import { computeExtraPermissions } from "@/lib/pim";

export interface SessionRBACContext {
  groups: string[];
  username: string;
  roleAssignments: RoleAssignment[];
  /**
   * Additional permissions granted by custom groups and currently-active PIM
   * elevations. Always reflects non-expired elevations at the time of load.
   */
  extraPermissions: Permission[];
}

function sessionIdentities(session: Session | null, username: string): string[] {
  const email = session?.user?.email ?? "";
  const explicitUsername = (session?.user as { username?: string } | undefined)?.username ?? "";
  return [username, explicitUsername, email].filter(Boolean);
}

export async function getSessionRBACContext(
  session: Session | null,
  revalidateSeconds = 60,
): Promise<SessionRBACContext> {
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const { username, roleAssignments } = await getRoleAssignmentsForSession(session, revalidateSeconds);

  let extraPermissions: Permission[] = [];
  try {
    const state = await getAccessState();
    const identities = sessionIdentities(session, username);
    extraPermissions = [...computeExtraPermissions(state, identities, groups)];
  } catch {
    // Fail-secure: if the access store is unavailable, grant no extra permissions.
    extraPermissions = [];
  }

  return { groups, username, roleAssignments, extraPermissions };
}

export function hasSessionPermission(
  context: SessionRBACContext,
  permission: Permission,
  scope = "/",
) {
  if (context.extraPermissions.includes("*") || context.extraPermissions.includes(permission)) {
    return true;
  }
  return hasPermission(
    context.groups,
    permission,
    context.roleAssignments,
    scope,
    context.username,
  );
}

/**
 * The granter's full effective permission set at `scope`, folding in custom-group
 * and active-PIM elevations (extraPermissions) on top of role assignments. Used
 * for privilege-ceiling checks (see assignmentExceedsGranter).
 */
export function getSessionEffectivePermissions(
  context: SessionRBACContext,
  scope = "/",
): Set<Permission> {
  const perms = getEffectivePermissions(
    context.groups,
    context.username,
    context.roleAssignments,
    scope,
  );
  for (const permission of context.extraPermissions) perms.add(permission);
  return perms;
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
