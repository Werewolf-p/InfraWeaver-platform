import "server-only";
import { getLegacyRoleId, type RoleAssignment } from "@/lib/rbac";
import { getAccessState } from "@/lib/access-store";
import { EMPTY_ACCESS_STATE, PIM_ROLES, isActivationActive, normalizeIdentity } from "@/lib/pim";
import {
  loadUsersConfig,
  normalizeGroupRoleAssignments,
  normalizeRoleAssignments,
  type LoadedUsersConfig,
  type UsersConfigUser,
} from "@/lib/users-config";
import type { MatrixGrant, MatrixPrincipal } from "@/lib/rbac-access-matrix";

/**
 * Server-side gathering for the RBAC access surface. Folds together every source
 * of access so the matrix does NOT understate it:
 *   - direct per-user role assignments (users.yaml)
 *   - group-principal assignments (users.yaml `groups:` section)
 *   - legacy Authentik-group → platform-role mapping
 *   - active PIM elevations (access ConfigMap)
 *   - custom-group membership (access ConfigMap)
 * The pure shaping lives in `rbac-access-matrix.ts`.
 */

function toGrant(assignment: RoleAssignment, source: string): MatrixGrant {
  return {
    roleId: assignment.roleId,
    scope: assignment.scope,
    effect: assignment.effect === "Deny" ? "Deny" : "Allow",
    expiresAt: assignment.expiresAt,
    source,
  };
}

function userIdentities(username: string, user: UsersConfigUser): string[] {
  return [username, user.email ?? ""].filter(Boolean);
}

function userGrants(username: string, user: UsersConfigUser, state = EMPTY_ACCESS_STATE, now = Date.now()): MatrixGrant[] {
  const grants: MatrixGrant[] = [];

  for (const assignment of normalizeRoleAssignments(username, user.role_assignments)) {
    grants.push(toGrant(assignment, "Direct"));
  }

  // Legacy Authentik group → platform role mapping (applies cluster-wide).
  for (const group of user.authentik_groups ?? []) {
    const legacyRoleId = getLegacyRoleId([group]);
    if (legacyRoleId) grants.push({ roleId: legacyRoleId, scope: "/", effect: "Allow", source: `Group: ${group}` });
  }

  const identities = userIdentities(username, user);

  // Active PIM elevations (best-effort — cluster-wide, time-boxed).
  for (const activation of state.activations) {
    if (!isActivationActive(activation, now)) continue;
    if (!identities.some((id) => normalizeIdentity(id) === normalizeIdentity(activation.user))) continue;
    const role = PIM_ROLES[activation.role];
    grants.push({
      roleId: activation.role,
      roleName: role ? `PIM: ${role.name}` : `PIM: ${activation.role}`,
      color: role?.color === "green" ? "teal" : role?.color,
      scope: "/",
      effect: "Allow",
      expiresAt: activation.expiresAt,
      source: "PIM (active)",
    });
  }

  // Custom-group membership (cluster-wide permissions).
  for (const customGroup of state.groups) {
    const isMember = customGroup.members.some((member) => identities.some((id) => normalizeIdentity(id) === normalizeIdentity(member)));
    if (!isMember) continue;
    grants.push({
      roleId: `custom-group:${customGroup.id}`,
      roleName: `Custom group: ${customGroup.name}`,
      scope: "/",
      effect: "Allow",
      source: "Custom group",
    });
  }

  return grants;
}

/** Builds the list of principals (users + groups) with all their gathered grants. */
export async function collectMatrixPrincipals(revalidateSeconds = 30): Promise<MatrixPrincipal[]> {
  const file: LoadedUsersConfig = await loadUsersConfig(revalidateSeconds);
  let state = EMPTY_ACCESS_STATE;
  try {
    state = await getAccessState();
  } catch {
    // Access store unavailable — matrix still shows users.yaml-sourced access.
  }

  const now = Date.now();
  const principals: MatrixPrincipal[] = [];
  const groupMembers = new Map<string, Set<string>>();

  for (const [username, user] of Object.entries(file.users)) {
    principals.push({
      principalId: username,
      principalType: "user",
      displayName: user.name ?? username,
      secondary: user.email ?? undefined,
      grants: userGrants(username, user, state, now),
    });
    for (const group of user.authentik_groups ?? []) {
      if (!groupMembers.has(group)) groupMembers.set(group, new Set());
      groupMembers.get(group)!.add(username);
    }
  }

  // Group principals: Authentik groups seen on users + any group with assignments.
  const groupNames = new Set<string>([...groupMembers.keys(), ...Object.keys(file.groups)]);
  for (const groupName of groupNames) {
    const grants: MatrixGrant[] = [];
    const legacyRoleId = getLegacyRoleId([groupName]);
    if (legacyRoleId) grants.push({ roleId: legacyRoleId, scope: "/", effect: "Allow", source: "Group membership" });
    for (const assignment of normalizeGroupRoleAssignments(groupName, file.groups[groupName]?.role_assignments)) {
      grants.push(toGrant(assignment, "Group assignment"));
    }
    const memberCount = groupMembers.get(groupName)?.size ?? 0;
    principals.push({
      principalId: groupName,
      principalType: "group",
      displayName: groupName,
      secondary: `${memberCount} member${memberCount === 1 ? "" : "s"}`,
      grants,
    });
  }

  return principals;
}

/** Finds a single principal by id + type (for the explain endpoint). */
export async function findMatrixPrincipal(
  principalId: string,
  principalType: "user" | "group",
  revalidateSeconds = 30,
): Promise<MatrixPrincipal | null> {
  const principals = await collectMatrixPrincipals(revalidateSeconds);
  return principals.find((p) => p.principalType === principalType && p.principalId === principalId) ?? null;
}
