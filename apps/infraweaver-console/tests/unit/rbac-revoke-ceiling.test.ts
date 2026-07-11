// Guards H1 (SECURITY-SCAN-2026-07-08): revokeRoleAssignment had NO privilege
// ceiling (grant has one). A `users:write` actor could revoke an Owner "*"
// assignment (lockout / denial-of-service) or strip a Deny (escalation). The
// revoke path now mirrors the grant ceiling: you cannot revoke an assignment
// whose role confers permissions you do not yourself hold.

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));

const loadUsersConfig = jest.fn();
const saveUsersConfig = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: (...args: unknown[]) => loadUsersConfig(...args),
  saveUsersConfig: (...args: unknown[]) => saveUsersConfig(...args),
  // Fixtures are already normalized, so pass the stored array straight through.
  normalizeRoleAssignments: (_u: string, raw: unknown) => raw ?? [],
  normalizeGroupRoleAssignments: (_g: string, raw: unknown) => raw ?? [],
}));

import {
  getEffectivePermissions,
  type BuiltInRoleId,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { revokeRoleAssignment } from "@/lib/rbac-assignments";
import { auditLog } from "@/lib/audit-log";

/** Concrete effective permission set a user gains from holding `roleId` at "/". */
function permsForRole(roleId: BuiltInRoleId): Set<Permission> {
  const a: RoleAssignment = {
    id: "granter-ra",
    roleId,
    scope: "/",
    principalType: "user",
    principalId: "actor",
    grantedBy: "system",
    grantedAt: "2026-01-01T00:00:00.000Z",
  };
  return getEffectivePermissions([], "actor", [a], "/");
}

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "target-ra",
    roleId: "platform-owner",
    scope: "/",
    principalType: "user",
    principalId: "victim",
    grantedBy: "owner",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fileWithUserAssignment(a: RoleAssignment) {
  return {
    users: { victim: { email: "victim@x", role_assignments: [a] } },
    groups: {},
    sha: "sha-1",
  };
}

function fileWithGroupAssignment(a: RoleAssignment) {
  return {
    users: {},
    groups: { "platform-users": { role_assignments: [a] } },
    sha: "sha-1",
  };
}

beforeEach(() => {
  loadUsersConfig.mockReset();
  saveUsersConfig.mockClear();
  (auditLog as jest.Mock).mockClear();
});

describe("revokeRoleAssignment — privilege ceiling (user principal)", () => {
  it("blocks a platform-admin from revoking an Owner assignment (lockout prevention)", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUserAssignment(assignment({ id: "own-1", roleId: "platform-owner" })));
    const granterPerms = permsForRole("platform-admin");

    const result = await revokeRoleAssignment(
      { assignmentId: "own-1", principalType: "user", principal: "victim" },
      { granterPermsAt: () => granterPerms, actor: "admin@x" },
    );

    expect(result).toEqual({ ok: false, status: 403, error: expect.stringContaining("exceeds your own permissions") });
    expect(saveUsersConfig).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith("rbac:revoke:denied", "admin@x", expect.stringContaining("own-1"));
  });

  it("blocks stripping a Deny whose role exceeds the revoker (escalation prevention)", async () => {
    // Removing a Deny of platform-owner would restore "*" to the target — the
    // same ceiling applies regardless of the assignment's effect.
    loadUsersConfig.mockResolvedValue(
      fileWithUserAssignment(assignment({ id: "deny-1", roleId: "platform-owner", effect: "Deny" })),
    );
    const granterPerms = permsForRole("platform-admin");

    const result = await revokeRoleAssignment(
      { assignmentId: "deny-1", principalType: "user", principal: "victim" },
      { granterPermsAt: () => granterPerms, actor: "admin@x" },
    );

    expect(result.ok).toBe(false);
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("allows an Owner (holds *) to revoke an Owner assignment", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUserAssignment(assignment({ id: "own-1", roleId: "platform-owner" })));
    const granterPerms = permsForRole("platform-owner");

    const result = await revokeRoleAssignment(
      { assignmentId: "own-1", principalType: "user", principal: "victim" },
      { granterPermsAt: () => granterPerms, actor: "owner@x" },
    );

    expect(result).toEqual({ ok: true });
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith("rbac:revoke", "owner@x", expect.stringContaining("own-1"));
  });

  it("allows a platform-admin to revoke a within-ceiling assignment (viewer)", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUserAssignment(assignment({ id: "view-1", roleId: "viewer" })));
    const granterPerms = permsForRole("platform-admin");

    const result = await revokeRoleAssignment(
      { assignmentId: "view-1", principalType: "user", principal: "victim" },
      { granterPermsAt: () => granterPerms, actor: "admin@x" },
    );

    expect(result).toEqual({ ok: true });
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for an unknown assignment id without consulting the ceiling", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUserAssignment(assignment({ id: "own-1", roleId: "platform-owner" })));
    const granterPerms = permsForRole("platform-admin");

    const result = await revokeRoleAssignment(
      { assignmentId: "does-not-exist", principalType: "user", principal: "victim" },
      { granterPermsAt: () => granterPerms, actor: "admin@x" },
    );

    expect(result).toEqual({ ok: false, status: 404, error: "Assignment not found" });
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });
});

describe("revokeRoleAssignment — privilege ceiling (group principal)", () => {
  it("blocks a platform-admin from revoking an Owner assignment on a group", async () => {
    loadUsersConfig.mockResolvedValue(fileWithGroupAssignment(assignment({ id: "gown-1", roleId: "platform-owner", principalType: "group", principalId: "platform-users" })));
    const granterPerms = permsForRole("platform-admin");

    const result = await revokeRoleAssignment(
      { assignmentId: "gown-1", principalType: "group", principal: "platform-users" },
      { granterPermsAt: () => granterPerms, actor: "admin@x" },
    );

    expect(result.ok).toBe(false);
    expect((result as { status: number }).status).toBe(403);
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("allows an Owner to revoke a group Owner assignment", async () => {
    loadUsersConfig.mockResolvedValue(fileWithGroupAssignment(assignment({ id: "gown-1", roleId: "platform-owner", principalType: "group", principalId: "platform-users" })));
    const granterPerms = permsForRole("platform-owner");

    const result = await revokeRoleAssignment(
      { assignmentId: "gown-1", principalType: "group", principal: "platform-users" },
      { granterPermsAt: () => granterPerms, actor: "owner@x" },
    );

    expect(result).toEqual({ ok: true });
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
  });
});
