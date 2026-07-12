import { NextResponse } from "next/server";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { loadUsersConfig, normalizeGroupRoleAssignments, normalizeRoleAssignments, type UsersConfigUser } from "@/lib/users-config";
import {
  getLegacyRoleId,
  resolveRoleDefinition,
  scopeLabel,
  type PermissionPattern,
  type RoleAssignment,
} from "@/lib/rbac";
import type { PlatformSubject, PlatformSubjectsResponse, SubjectBinding } from "@/app/(dashboard)/rbac-viz/types";

/**
 * Builds a resolved binding from a roleId + scope, looking up the concrete
 * permissions and presentation metadata from the built-in role registry.
 * Returns null when the roleId is unknown so callers can skip it cleanly.
 */
function toBinding(roleId: string, scope: string, sourceLabel: string, expiresAt?: string): SubjectBinding | null {
  const role = resolveRoleDefinition(roleId);
  if (!role) return null;
  return {
    roleId: role.id,
    roleName: role.name,
    scope,
    scopeLabel: scopeLabel(scope),
    permissions: role.permissions,
    color: role.color,
    sourceLabel,
    expiresAt,
  };
}

function dedupeBindings(bindings: SubjectBinding[]): SubjectBinding[] {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.roleId}@${binding.scope}@${binding.sourceLabel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unionPermissions(bindings: SubjectBinding[]): PermissionPattern[] {
  const set = new Set<PermissionPattern>();
  for (const binding of bindings) for (const permission of binding.permissions) set.add(permission);
  return [...set];
}

function resolveUser(username: string, user: UsersConfigUser): PlatformSubject {
  const groups = user.authentik_groups ?? [];
  const assignments = normalizeRoleAssignments(username, user.role_assignments);
  const bindings: SubjectBinding[] = [];

  // Group membership -> legacy platform role (platform-admins, etc.).
  for (const group of groups) {
    const legacyRoleId = getLegacyRoleId([group]);
    if (!legacyRoleId) continue;
    const binding = toBinding(legacyRoleId, "/", `Group: ${group}`);
    if (binding) bindings.push(binding);
  }

  // Direct role assignments (roleId @ scope) targeting this user.
  for (const assignment of assignments) {
    if (assignment.principalType === "group") continue;
    const binding = toBinding(assignment.roleId, assignment.scope, "Direct assignment", assignment.expiresAt);
    if (binding) bindings.push(binding);
  }

  const deduped = dedupeBindings(bindings);
  return {
    id: `user:${username}`,
    kind: "User",
    name: username,
    secondary: user.email || user.name || undefined,
    related: groups,
    bindings: deduped,
    permissions: unionPermissions(deduped),
  };
}

interface GroupAccumulator {
  members: Set<string>;
  assignments: Array<RoleAssignment>;
}

export const GET = withRoute(["security:read", "users:read", "rbac:admin"], async () => {
  try {
    const file = await loadUsersConfig(60);
    const users: PlatformSubject[] = [];
    const groupMap = new Map<string, GroupAccumulator>();

    const ensureGroup = (name: string): GroupAccumulator => {
      let entry = groupMap.get(name);
      if (!entry) {
        entry = { members: new Set<string>(), assignments: [] };
        groupMap.set(name, entry);
      }
      return entry;
    };

    for (const [username, user] of Object.entries(file.users)) {
      users.push(resolveUser(username, user));

      for (const group of user.authentik_groups ?? []) {
        ensureGroup(group).members.add(username);
      }
      // Legacy: group-targeted assignments once stored on a user record.
      for (const assignment of normalizeRoleAssignments(username, user.role_assignments)) {
        if (assignment.principalType === "group" && assignment.principalId) {
          ensureGroup(assignment.principalId).assignments.push(assignment);
        }
      }
    }

    // Current model: group-principal assignments live under the top-level groups: section.
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const assignment of normalizeGroupRoleAssignments(groupName, group.role_assignments)) {
        ensureGroup(groupName).assignments.push(assignment);
      }
    }

    const groups: PlatformSubject[] = [...groupMap.entries()].map(([name, acc]) => {
      const bindings: SubjectBinding[] = [];

      // What membership in this group alone confers (legacy platform mapping).
      const legacyRoleId = getLegacyRoleId([name]);
      if (legacyRoleId) {
        const binding = toBinding(legacyRoleId, "/", "Group membership");
        if (binding) bindings.push(binding);
      }

      // Roles assigned directly to the group as a principal.
      for (const assignment of acc.assignments) {
        const binding = toBinding(assignment.roleId, assignment.scope, "Group assignment", assignment.expiresAt);
        if (binding) bindings.push(binding);
      }

      const deduped = dedupeBindings(bindings);
      const members = [...acc.members].sort();
      return {
        id: `group:${name}`,
        kind: "Group",
        name,
        secondary: `${members.length} member${members.length === 1 ? "" : "s"}`,
        related: members,
        bindings: deduped,
        permissions: unionPermissions(deduped),
      };
    });

    users.sort((a, b) => a.name.localeCompare(b.name));
    groups.sort((a, b) => a.name.localeCompare(b.name));

    const payload: PlatformSubjectsResponse = { users, groups };
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
