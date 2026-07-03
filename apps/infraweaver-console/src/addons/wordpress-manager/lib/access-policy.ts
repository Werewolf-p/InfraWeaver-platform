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
  email?: string;
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
  const groupAssignments = flattenGroupAssignments(groups);

  const allowed: string[] = [];
  for (const [username, user] of Object.entries(users)) {
    if (isAllowed(subjectFor(username, user, groupAssignments), "wordpress:read", scope)) allowed.push(username);
  }
  return allowed.sort();
}

// Group-principal assignments live under `groups:`; the core resolver applies one
// to a user only when the user is a member of that group (RbacSubject.groups),
// so we pass them all and let membership filtering happen there.
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

/** WordPress roles InfraWeaver provisions, mapped from the site-scoped RBAC verbs. */
export type WordpressRole = "administrator" | "editor" | "subscriber";

export interface DesiredWordpressUser {
  username: string;
  email: string;
  role: WordpressRole;
}

export interface DesiredWordpressUsers {
  users: DesiredWordpressUser[];
  /** Authorized users that cannot become WordPress accounts (no email on record). */
  skippedNoEmail: string[];
}

/**
 * The WordPress accounts a site should have, derived from the same RBAC facts as
 * the Authentik gate: everyone with site access gets an account whose WordPress
 * role mirrors their strongest site-scoped verb (admin → administrator,
 * write → editor, read → subscriber). Accounts need an email (it is also what
 * links the SSO identity to the WordPress user), so users without one are
 * reported rather than silently dropped. Sorted for stable reconciles.
 */
export function computeSiteWordpressUsers(
  site: string,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
): DesiredWordpressUsers {
  const scope = siteScope(site);
  const groupAssignments = flattenGroupAssignments(groups);

  const desired: DesiredWordpressUser[] = [];
  const skippedNoEmail: string[] = [];
  for (const [username, user] of Object.entries(users)) {
    const subject = subjectFor(username, user, groupAssignments);
    if (!isAllowed(subject, "wordpress:read", scope)) continue;
    if (!user.email) {
      skippedNoEmail.push(username);
      continue;
    }
    const role: WordpressRole = isAllowed(subject, "wordpress:admin", scope)
      ? "administrator"
      : isAllowed(subject, "wordpress:write", scope)
        ? "editor"
        : "subscriber";
    desired.push({ username, email: user.email, role });
  }
  return {
    users: desired.sort((a, b) => a.username.localeCompare(b.username)),
    skippedNoEmail: skippedNoEmail.sort(),
  };
}
