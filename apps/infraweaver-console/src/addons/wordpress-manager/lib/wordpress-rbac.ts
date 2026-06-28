import type { Session } from "next-auth";
import { getRole, hasPermission, type Permission, type RoleAssignment } from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export const WORDPRESS_NAMESPACE = "wordpress";

/**
 * WordPress addon permissions. These are first-class members of core's
 * `Permission` union (and carried by the built-in `wordpress-*` roles), mirroring
 * how the game-hub addon wires its permissions. `WordpressPermission` is the
 * narrowed subset the addon cares about, so handlers get exhaustiveness without
 * any unsafe cast — the core permission engine resolves them like any other.
 */
export type WordpressPermission = Extract<Permission, `wordpress:${string}`>;

export const WORDPRESS_PERMISSIONS: ReadonlyArray<WordpressPermission> = [
  "wordpress:read",
  "wordpress:write",
  "wordpress:admin",
];

export function wordpressScope(site: string): string {
  return `/wordpress/sites/${site}`;
}

/**
 * Evaluate a WordPress permission for a session's identity at a given scope.
 * The platform owner / admin (`*`) always passes via the same core check every
 * other addon uses, so the owner can never be locked out and needs no grant.
 */
export function hasWordpressPermission(
  groups: string[],
  username: string,
  roleAssignments: RoleAssignment[],
  permission: WordpressPermission,
  site: string,
): boolean {
  if (getRole(groups) === "admin") return true;
  return hasPermission(groups, permission, roleAssignments, wordpressScope(site), username);
}

/**
 * Sites a user has any non-expired scoped grant on, parsed from their role
 * assignments. Expired grants are ignored so a revoked, time-boxed grant can no
 * longer enumerate sites (mirrors the expiry check in the core engine).
 */
export function getScopedWordpressSites(roleAssignments: RoleAssignment[]): string[] {
  const now = new Date();
  const scoped = new Set<string>();
  for (const assignment of roleAssignments) {
    if (assignment.expiresAt && new Date(assignment.expiresAt) < now) continue;
    const match = assignment.scope.match(/^\/wordpress\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
    if (match) scoped.add(match[1]);
  }
  return [...scoped];
}

export async function getWordpressAccessContext(session: Session | null, revalidateSeconds = 60) {
  const groups: string[] = (session?.user as { groups?: string[] } | undefined)?.groups ?? [];
  const { username, roleAssignments } = await getRoleAssignmentsForSession(session, revalidateSeconds);
  return {
    groups,
    username,
    roleAssignments,
    isAdmin: getRole(groups) === "admin",
  };
}
