import "server-only";
import { randomUUID } from "node:crypto";
import { auditLog } from "@/lib/audit-log";
import { assignmentExceedsGranter, getBuiltInRoles, type Permission, type RoleAssignment } from "@/lib/rbac";
import {
  loadUsersConfig,
  normalizeGroupRoleAssignments,
  normalizeRoleAssignments,
  saveUsersConfig,
} from "@/lib/users-config";

/**
 * Shared grant/revoke logic for role assignments, used by both
 * `/api/rbac/assignments` and `/api/users-config/[username]/rbac`. Centralizes:
 *   load users.yaml → privilege-ceiling check → persist → audit.
 *
 * User-principal assignments are stored on the target user record; GROUP-principal
 * assignments are stored under the top-level `groups:` section with the group as
 * principal, so `getEffectivePermissions`' group filter resolves them for members.
 */

export interface GrantAssignmentInput {
  roleId: string;
  scope: string;
  principalType: "user" | "group";
  /** Username (for user principals) or Authentik group name (for group principals). */
  principal: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
}

export interface AssignmentActionContext {
  /** The granter's full effective permission set at "/" (for the privilege ceiling). */
  granterPerms: Set<Permission>;
  /** Actor identity recorded in git commit + audit log. */
  actor: string;
}

export type AssignmentActionResult =
  | { ok: true; assignment: RoleAssignment }
  | { ok: false; status: number; error: string };

export type RevokeResult = { ok: true } | { ok: false; status: number; error: string };

function isKnownRole(roleId: string): boolean {
  return getBuiltInRoles().some((role) => role.id === roleId);
}

function sameEffect(a?: "Allow" | "Deny", b?: "Allow" | "Deny"): boolean {
  return (a ?? "Allow") === (b ?? "Allow");
}

export async function grantRoleAssignment(
  input: GrantAssignmentInput,
  ctx: AssignmentActionContext,
): Promise<AssignmentActionResult> {
  if (!isKnownRole(input.roleId)) return { ok: false, status: 400, error: "Unknown role" };

  // Privilege ceiling: never grant a role conferring permissions the granter lacks.
  if (assignmentExceedsGranter(ctx.granterPerms, input.roleId)) {
    await auditLog(
      "rbac:assign:denied",
      ctx.actor,
      `Denied granting role '${input.roleId}' to ${input.principalType} '${input.principal}': exceeds granter permissions`,
    );
    return { ok: false, status: 403, error: "Cannot grant a role that exceeds your own permissions" };
  }

  const file = await loadUsersConfig();

  const newAssignment: RoleAssignment = {
    id: randomUUID(),
    roleId: input.roleId,
    scope: input.scope,
    principalType: input.principalType,
    principalId: input.principal,
    grantedBy: ctx.actor,
    grantedAt: new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.effect ? { effect: input.effect } : {}),
  };

  if (input.principalType === "group") {
    const groupName = input.principal;
    const group = file.groups[groupName] ?? {};
    const existing = normalizeGroupRoleAssignments(groupName, group.role_assignments);
    if (existing.some((a) => a.roleId === input.roleId && a.scope === input.scope && sameEffect(a.effect, input.effect))) {
      return { ok: false, status: 409, error: "Assignment already exists" };
    }
    const nextGroups = {
      ...file.groups,
      [groupName]: { ...group, role_assignments: [...existing, newAssignment] },
    };
    await saveUsersConfig(file.users, file.sha, `rbac: grant ${input.roleId} to group ${groupName} at ${input.scope}`, nextGroups);
    await auditLog("rbac:assign", ctx.actor, `Granted role '${input.roleId}' to group '${groupName}' at scope '${input.scope}'`);
    return { ok: true, assignment: newAssignment };
  }

  const username = input.principal;
  const user = file.users[username];
  if (!user) return { ok: false, status: 404, error: "User not found" };
  const existing = normalizeRoleAssignments(username, user.role_assignments);
  if (existing.some((a) => a.roleId === input.roleId && a.scope === input.scope && sameEffect(a.effect, input.effect))) {
    return { ok: false, status: 409, error: "Assignment already exists" };
  }
  file.users[username] = { ...user, role_assignments: [...existing, newAssignment] };
  await saveUsersConfig(file.users, file.sha, `rbac: grant ${input.roleId} to ${username} at ${input.scope}`, file.groups);
  await auditLog("rbac:assign", ctx.actor, `Granted role '${input.roleId}' to '${username}' at scope '${input.scope}'`);
  return { ok: true, assignment: newAssignment };
}

export interface RevokeAssignmentInput {
  assignmentId: string;
  principalType: "user" | "group";
  /** Username (user principals) or group name (group principals). */
  principal: string;
}

export async function revokeRoleAssignment(input: RevokeAssignmentInput, actor: string): Promise<RevokeResult> {
  const file = await loadUsersConfig();

  if (input.principalType === "group") {
    const group = file.groups[input.principal];
    const before = group?.role_assignments ?? [];
    const after = before.filter((a) => a.id !== input.assignmentId);
    if (before.length === after.length) return { ok: false, status: 404, error: "Assignment not found" };
    const nextGroups = { ...file.groups, [input.principal]: { ...group, role_assignments: after } };
    await saveUsersConfig(file.users, file.sha, `rbac: revoke assignment ${input.assignmentId} from group ${input.principal}`, nextGroups);
    await auditLog("rbac:revoke", actor, `Revoked assignment '${input.assignmentId}' from group '${input.principal}'`);
    return { ok: true };
  }

  const user = file.users[input.principal];
  if (!user) return { ok: false, status: 404, error: "User not found" };
  const before = normalizeRoleAssignments(input.principal, user.role_assignments);
  const after = before.filter((a) => a.id !== input.assignmentId);
  if (before.length === after.length) return { ok: false, status: 404, error: "Assignment not found" };
  file.users[input.principal] = { ...user, role_assignments: after };
  await saveUsersConfig(file.users, file.sha, `rbac: revoke assignment ${input.assignmentId} from ${input.principal}`, file.groups);
  await auditLog("rbac:revoke", actor, `Revoked assignment '${input.assignmentId}' from '${input.principal}'`);
  return { ok: true };
}
