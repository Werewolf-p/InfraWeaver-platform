/**
 * Pure policy: given the parsed users/groups config, who is authorized on a
 * storage scope and at what access mode. Mirrors the WordPress site-access
 * policy (`addons/wordpress-manager/lib/access-policy.ts`) so "who can see this
 * folder" is derived entirely from InfraWeaver RBAC and can never diverge from
 * it.
 *
 * Kept dependency-free (only the pure core RBAC engine) so it is unit-testable
 * without any git/Authentik/server-only I/O.
 */
import { createHash } from "node:crypto";
import { isAllowed, type RbacSubject, type RoleAssignment } from "@/lib/rbac";
import type { NasAccess } from "@/lib/nas/folder-acl";
import { nasFolderScope, nasShareScope, parseNasScope } from "@/lib/nas/scope";

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
 * The Authentik group that gates one storage scope at one access mode, e.g.
 * `storage-truenas-media-rw` for a share, or
 * `storage-truenas-infraweaver-media-a1b2c3-rw` for a folder inside one.
 *
 * Nextcloud provisions groups from the OIDC `groups` claim on every login, so
 * binding an external-storage mount to this name makes the folder appear in
 * Files for exactly the users InfraWeaver granted it to.
 *
 * Per-FOLDER, not merely per-share, because that is the granularity apps
 * actually mount at: Nextcloud's `/Media` is the `media` subfolder of the
 * `infraweaver` share. A share-only group would leave a user granted on the
 * folder out of the group that decides whether they see the folder.
 *
 * A folder scope's name carries a hash of the full scope. Flattening `movies/4k`
 * to `movies-4k` would otherwise collide with a sibling folder literally named
 * `movies-4k`, and a collision here is not cosmetic: `syncAppAccessMembers` sets
 * a group's membership to EXACTLY the computed list, so two scopes sharing a
 * group name would clobber each other's member list on every reconcile. 12 hex
 * characters (48 bits) keeps the birthday bound far out of reach for any
 * plausible number of folders.
 */
export function storageAccessGroupName(
  provider: string,
  share: string,
  access: NasAccess,
  subfolder = "",
): string {
  const suffix = access === "readwrite" ? "rw" : "ro";
  const scope = nasFolderScope(provider, share, subfolder);
  const parsed = parseNasScope(scope)!;
  if (!parsed.subfolder) return `storage-${parsed.provider}-${parsed.share}-${suffix}`;
  const flat = parsed.subfolder.split("/").join("-");
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `storage-${parsed.provider}-${parsed.share}-${flat}-${digest}-${suffix}`;
}

/**
 * Every username whose effective permissions confer `access` at `scope`.
 *
 * That intentionally includes users with a grant on the exact scope, users with
 * a grant on any ancestor scope (`/nas/truenas/media` covers `.../media/movies`,
 * `/` covers everything), and platform owners/admins — exactly the set the
 * folder ACL admits, so a downstream gate can never diverge from RBAC.
 *
 * Sorted for stable, diff-friendly reconciles.
 */
export function computeStorageAccessUsers(
  scope: string,
  access: NasAccess,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
): string[] {
  const permission = access === "readwrite" ? "nas:write" : "nas:read";
  const groupAssignments = flattenGroupAssignments(groups);

  const allowed: string[] = [];
  for (const [username, user] of Object.entries(users)) {
    if (isAllowed(subjectFor(username, user, groupAssignments), permission, scope)) allowed.push(username);
  }
  return allowed.sort();
}

/**
 * Convenience wrapper keyed by NAS location rather than scope string. An empty
 * `subfolder` addresses the share itself.
 */
export function computeShareAccessUsers(
  provider: string,
  share: string,
  access: NasAccess,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
  subfolder = "",
): string[] {
  return computeStorageAccessUsers(nasFolderScope(provider, share, subfolder), access, users, groups);
}

export interface StorageGrant {
  assignmentId: string;
  roleId: string;
  scope: string;
  principalType: "user" | "group";
  principalId: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
  /** True when this grant sits on an ancestor of the queried scope, not on it. */
  inherited: boolean;
}

/**
 * Every storage grant that bears on `scope`, whether made directly on it or
 * inherited from an ancestor. Powers the access panel's "who can reach this
 * folder, and why" list — inherited grants are shown but must be revoked at the
 * scope that actually carries them.
 */
export function listStorageGrantsForScope(
  scope: string,
  users: Record<string, AccessUser>,
  groups: Record<string, AccessGroup>,
): StorageGrant[] {
  const grants: StorageGrant[] = [];
  const push = (assignment: RoleAssignment, principalType: "user" | "group", principalId: string) => {
    if (!coversScope(assignment.scope, scope)) return;
    grants.push({
      assignmentId: assignment.id,
      roleId: assignment.roleId,
      scope: assignment.scope,
      principalType,
      principalId,
      grantedBy: assignment.grantedBy,
      grantedAt: assignment.grantedAt,
      ...(assignment.expiresAt ? { expiresAt: assignment.expiresAt } : {}),
      ...(assignment.effect ? { effect: assignment.effect } : {}),
      inherited: assignment.scope !== scope,
    });
  };

  for (const [username, user] of Object.entries(users)) {
    for (const assignment of user.role_assignments ?? []) push(assignment, "user", username);
  }
  for (const [groupName, group] of Object.entries(groups)) {
    for (const assignment of group.role_assignments ?? []) {
      push(assignment, "group", assignment.principalId || groupName);
    }
  }
  return grants.sort((a, b) => a.principalId.localeCompare(b.principalId) || a.scope.localeCompare(b.scope));
}

/**
 * Boundary-aware ancestor test, inlined from `scopeCovers` to keep this module's
 * import surface to the pure RBAC core it already depends on.
 */
function coversScope(grantScope: string, requestedScope: string): boolean {
  if (grantScope === requestedScope) return true;
  const base = grantScope.endsWith("/") ? grantScope : `${grantScope}/`;
  return requestedScope.startsWith(base);
}

/** Re-exported so callers building a folder scope need one import, not two. */
export { nasFolderScope, nasShareScope };

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
