import type { Session } from "next-auth";
import { getRole, hasPermission, resolveRoleDefinition, type Permission, type RoleAssignment } from "@/lib/rbac";
import { getRoleAssignmentsForSession } from "@/lib/users-config";

export const WORDPRESS_NAMESPACE = "wordpress";

/**
 * Scopes that confer access to EVERY WordPress site (the "resource group" tier,
 * Azure-style): the platform root and the WordPress namespace itself, plus the
 * `/wordpress/sites` collection. A grant at any of these cascades to all sites,
 * whereas `/wordpress/sites/<site>` targets a single one.
 */
const WORDPRESS_ALL_SITES_SCOPES: ReadonlySet<string> = new Set(["/", "/wordpress", "/wordpress/sites"]);

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
 * longer enumerate sites (mirrors the expiry check in the core engine). Explicit
 * Deny assignments subtract the site (deny-wins, matching the core engine's
 * semantics) so an explicitly-denied user cannot enumerate sites.
 */
export function getScopedWordpressSites(roleAssignments: RoleAssignment[]): string[] {
  const now = new Date();
  const allowed = new Set<string>();
  const denied = new Set<string>();
  for (const assignment of roleAssignments) {
    if (assignment.expiresAt && new Date(assignment.expiresAt) < now) continue;
    const match = assignment.scope.match(/^\/wordpress\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
    if (!match) continue;
    if (assignment.effect === "Deny") denied.add(match[1]);
    else allowed.add(match[1]);
  }
  return [...allowed].filter((site) => !denied.has(site));
}

/**
 * Whether the user has a blanket ("resource-group") WordPress grant that cascades
 * to every site — a non-expired assignment at `/`, `/wordpress` or `/wordpress/sites`
 * whose role carries any wordpress permission (or `*`). When true, callers should
 * treat the user as having access to ALL sites rather than enumerating specific
 * ones via {@link getScopedWordpressSites}. (Platform admins pass via group role
 * checks elsewhere and need no assignment.)
 */
export function hasAllWordpressAccess(roleAssignments: RoleAssignment[]): boolean {
  const now = new Date();
  for (const assignment of roleAssignments) {
    if (assignment.expiresAt && new Date(assignment.expiresAt) < now) continue;
    // Deny assignments never grant access (deny-wins in the core engine); a
    // denied principal must not fall through to the full site list here.
    if (assignment.effect === "Deny") continue;
    if (!WORDPRESS_ALL_SITES_SCOPES.has(assignment.scope)) continue;
    const role = resolveRoleDefinition(assignment.roleId);
    if (!role) continue;
    if (role.permissions.includes("*") || role.permissions.some((p) => p.startsWith("wordpress:"))) {
      return true;
    }
  }
  return false;
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
