/**
 * Pure policy: given the parsed users/groups config, which usernames are authorized
 * for a WordPress site. This is the single source of truth for a site's Authentik
 * access-group membership, derived entirely from InfraWeaver RBAC so "who can log
 * into the site" always equals "who InfraWeaver granted the site to".
 *
 * Kept dependency-free (only the pure core RBAC engine) so it is unit-testable
 * without any git/Authentik/server-only I/O.
 */
import { isAllowed, type RbacSubject, type RoleAssignment } from "@/lib/rbac";

/** The subset of the users.yaml user record this policy needs. */
export interface AccessUser {
  authentik_groups?: string[];
  role_assignments?: RoleAssignment[];
}

/** The subset of a users.yaml group record this policy needs. */
export interface AccessGroup {
  role_assignments?: RoleAssignment[];
}

/** Mirrors {@link import("./wordpress-rbac").wordpressScope}; inlined to keep this module pure. */
function siteScope(site: string): string {
  return `/wordpress/sites/${site}`;
}

/**
 * The usernames authorized to access `site`, i.e. every user whose effective
 * permissions confer `wordpress:read` at the site's scope. That intentionally
 * includes users with a per-site grant, users with an all-sites (`/wordpress`)
 * grant, and platform owners/admins (`*`) — exactly the set InfraWeaver already
 * treats as allowed for the site, so the SSO gate can never diverge from RBAC.
 * Result is sorted for stable, diff-friendly reconciles.
 */
export function computeSiteAccessUsers(
  site: string,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
): string[] {
  const scope = siteScope(site);

  // Group-principal assignments live under `groups:`; the core resolver applies one
  // to a user only when the user is a member of that group (RbacSubject.groups),
  // so we pass them all and let membership filtering happen there.
  const groupAssignments: RoleAssignment[] = Object.entries(groups).flatMap(([groupName, group]) =>
    (group.role_assignments ?? []).map((a) => ({
      ...a,
      principalType: "group" as const,
      principalId: a.principalId || groupName,
    })),
  );

  const allowed: string[] = [];
  for (const [username, user] of Object.entries(users)) {
    const subject: RbacSubject = {
      groups: user.authentik_groups ?? [],
      username,
      roleAssignments: [...(user.role_assignments ?? []), ...groupAssignments],
    };
    if (isAllowed(subject, "wordpress:read", scope)) allowed.push(username);
  }
  return allowed.sort();
}
