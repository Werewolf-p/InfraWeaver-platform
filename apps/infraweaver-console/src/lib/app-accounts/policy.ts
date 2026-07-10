/**
 * Pure policy: given the parsed users/groups config, which local app accounts a
 * scope should have, and at what role — derived entirely from InfraWeaver RBAC.
 *
 * This is the app-account analogue of the WordPress site policy
 * (`addons/wordpress-manager/lib/access-policy.ts#computeSiteWordpressUsers`) and
 * the NAS access policy (`lib/nas/access-policy.ts`). It is deliberately
 * app-agnostic: it takes the app's read/admin *permissions* as parameters rather
 * than hardcoding any, so the same function serves Jellyfin, Immich, or any future
 * adapter — each passes its own permission pair.
 *
 * Kept dependency-free (only the pure core RBAC engine) so it is unit-testable
 * with no git/HTTP/server-only I/O.
 */
import { isAllowed, type Permission, type RbacSubject, type RoleAssignment } from "@/lib/rbac";
import type { AppUserRole, DesiredAppUser, DesiredAppUsers } from "@/lib/app-accounts/types";

/** The subset of the users.yaml user record this policy needs. */
export interface AccessUser {
  email?: string;
  authentik_groups?: string[];
  role_assignments?: RoleAssignment[];
}

/** The subset of a users.yaml group record this policy needs. */
export interface AccessGroup {
  role_assignments?: RoleAssignment[];
}

/**
 * The local accounts the app should have for `scope`: everyone whose effective
 * permissions confer the app's `read` permission there gets an account, and its
 * role mirrors their strongest verb (app `admin` → admin, otherwise standard user).
 *
 * That set intentionally includes users granted directly on the scope, users who
 * inherit it from an ancestor (`/` = platform owner), and platform admins — exactly
 * the set every other InfraWeaver gate admits, so the app's account list can never
 * diverge from RBAC.
 *
 * An account needs an email (it is how we deliver the generated credential and how
 * a later SSO login links to the local account), so authorized users without one
 * are reported in `skippedNoEmail` rather than silently dropped. Sorted for stable,
 * diff-friendly reconciles.
 */
export function computeDesiredAppUsers(
  scope: string,
  permissionRead: Permission,
  permissionAdmin: Permission,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
): DesiredAppUsers {
  const groupAssignments = flattenGroupAssignments(groups);

  const desired: DesiredAppUser[] = [];
  const skippedNoEmail: string[] = [];
  for (const [username, user] of Object.entries(users)) {
    const subject = subjectFor(username, user, groupAssignments);
    if (!isAllowed(subject, permissionRead, scope)) continue;
    if (!user.email) {
      skippedNoEmail.push(username);
      continue;
    }
    const role: AppUserRole = isAllowed(subject, permissionAdmin, scope) ? "admin" : "user";
    desired.push({ username, email: user.email, role });
  }
  return {
    users: desired.sort((a, b) => a.username.localeCompare(b.username)),
    skippedNoEmail: skippedNoEmail.sort(),
  };
}

// Group-principal assignments live under `groups:`; the core resolver applies one
// to a user only when the user is a member of that group (RbacSubject.groups), so
// we pass them all and let membership filtering happen there.
function flattenGroupAssignments(groups: Record<string, AccessGroup>): RoleAssignment[] {
  return Object.entries(groups).flatMap(([groupName, group]) =>
    (group.role_assignments ?? []).map((a) => ({
      ...a,
      principalType: "group" as const,
      principalId: a.principalId || groupName,
    })),
  );
}

function subjectFor(username: string, user: AccessUser, groupAssignments: RoleAssignment[]): RbacSubject {
  return {
    groups: user.authentik_groups ?? [],
    username,
    roleAssignments: [...(user.role_assignments ?? []), ...groupAssignments],
  };
}
