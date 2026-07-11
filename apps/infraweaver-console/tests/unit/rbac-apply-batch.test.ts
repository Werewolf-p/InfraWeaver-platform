// applyRoleAssignments — the batch apply path. Its reason to exist is that a role
// SWAP (revoke one grant at a scope, add another at the same scope) must land as a
// SINGLE users.yaml commit and a SINGLE "your access was changed from X to Y"
// email — not the paired revoke-then-grant two separate calls produce (two commits,
// two emails). These tests pin that contract plus the atomic, fail-closed ceiling.

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

// Capture the change-notice calls without sending mail. The REAL diff is pulled
// via requireActual so we can prove the captured before/after collapses to one
// "changed" line — i.e. exactly one "changed" email would be sent.
const notifyRoleAssignmentChangeByEmail = jest.fn();
jest.mock("@/lib/rbac-change-email", () => ({
  notifyRoleAssignmentChangeByEmail: (...args: unknown[]) => notifyRoleAssignmentChangeByEmail(...args),
}));

import {
  getEffectivePermissions,
  type BuiltInRoleId,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { applyRoleAssignments } from "@/lib/rbac-assignments";
import { auditLog } from "@/lib/audit-log";

const { diffRoleAssignments } = jest.requireActual("@/lib/rbac-change-email") as typeof import("@/lib/rbac-change-email");

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
    id: "ra-1",
    roleId: "jellyfin-user",
    scope: "/jellyfin",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fileWithUser(assignments: RoleAssignment[]) {
  return {
    users: { alice: { email: "alice@x", name: "Alice", role_assignments: assignments } },
    groups: {},
    sha: "sha-1",
  };
}

beforeEach(() => {
  loadUsersConfig.mockReset();
  saveUsersConfig.mockClear();
  notifyRoleAssignmentChangeByEmail.mockClear();
  (auditLog as jest.Mock).mockClear();
});

describe("applyRoleAssignments — role swap", () => {
  it("swaps a role at one scope in ONE commit and ONE 'changed' email", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "old", roleId: "jellyfin-user", scope: "/jellyfin" })]));

    const result = await applyRoleAssignments(
      {
        principalType: "user",
        principal: "alice",
        revokes: ["old"],
        grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }],
      },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    expect(result).toMatchObject({ ok: true, grantedCount: 1, revokedCount: 1 });

    // ONE commit.
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);

    // ONE change notice…
    expect(notifyRoleAssignmentChangeByEmail).toHaveBeenCalledTimes(1);
    // …and its before/after collapses to exactly one "changed" line (from → to),
    // which is what makes it a single "changed" email rather than revoke + grant.
    const { before, after } = notifyRoleAssignmentChangeByEmail.mock.calls[0][0] as {
      before: RoleAssignment[];
      after: RoleAssignment[];
    };
    const diff = diffRoleAssignments(before, after);
    expect(diff.granted).toHaveLength(0);
    expect(diff.revoked).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].scope).toBe("/jellyfin");
    expect(diff.changed[0].from.roleId).toBe("jellyfin-user");
    expect(diff.changed[0].to.roleId).toBe("jellyfin-admin");
  });

  it("persists the swapped set: old grant gone, new grant present", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "old", roleId: "jellyfin-user", scope: "/jellyfin" })]));

    await applyRoleAssignments(
      { principalType: "user", principal: "alice", revokes: ["old"], grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }] },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    const savedUsers = saveUsersConfig.mock.calls[0][0] as Record<string, { role_assignments: RoleAssignment[] }>;
    const saved = savedUsers.alice.role_assignments;
    expect(saved).toHaveLength(1);
    expect(saved[0].roleId).toBe("jellyfin-admin");
    expect(saved.some((a) => a.id === "old")).toBe(false);
  });
});

describe("applyRoleAssignments — atomic + fail-closed", () => {
  it("rejects the WHOLE batch when any grant exceeds the granter's ceiling (no write, no email)", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "old", roleId: "jellyfin-user" })]));

    const result = await applyRoleAssignments(
      {
        principalType: "user",
        principal: "alice",
        revokes: ["old"],
        // platform-admin cannot mint an Owner "*"; the whole batch must fail.
        grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }, { roleId: "platform-owner", scope: "/" }],
      },
      { granterPerms: permsForRole("platform-admin"), actor: "admin@x" },
    );

    expect(result).toEqual({ ok: false, status: 403, error: expect.stringContaining("exceeds your own permissions") });
    expect(saveUsersConfig).not.toHaveBeenCalled();
    expect(notifyRoleAssignmentChangeByEmail).not.toHaveBeenCalled();
  });

  it("404s when a revoke id is not present, before writing anything", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "old" })]));

    const result = await applyRoleAssignments(
      { principalType: "user", principal: "alice", revokes: ["missing"], grants: [] },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("409s a grant that duplicates one that survives the revokes", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "keep", roleId: "jellyfin-user", scope: "/jellyfin" })]));

    const result = await applyRoleAssignments(
      { principalType: "user", principal: "alice", revokes: [], grants: [{ roleId: "jellyfin-user", scope: "/jellyfin" }] },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("no-ops (no commit, no email) when the batch is empty", async () => {
    loadUsersConfig.mockResolvedValue(fileWithUser([assignment({ id: "old" })]));

    const result = await applyRoleAssignments(
      { principalType: "user", principal: "alice", revokes: [], grants: [] },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    expect(result).toMatchObject({ ok: true, grantedCount: 0, revokedCount: 0 });
    expect(saveUsersConfig).not.toHaveBeenCalled();
    expect(notifyRoleAssignmentChangeByEmail).not.toHaveBeenCalled();
  });
});

describe("applyRoleAssignments — group principal", () => {
  it("writes ONE commit but sends NO email (groups fan out to members)", async () => {
    loadUsersConfig.mockResolvedValue({
      users: {},
      groups: { "media-team": { role_assignments: [assignment({ id: "g-old", roleId: "jellyfin-user", principalType: "group", principalId: "media-team" })] } },
      sha: "sha-1",
    });

    const result = await applyRoleAssignments(
      {
        principalType: "group",
        principal: "media-team",
        revokes: ["g-old"],
        grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }],
      },
      { granterPerms: permsForRole("platform-owner"), actor: "owner@x" },
    );

    expect(result).toMatchObject({ ok: true, grantedCount: 1, revokedCount: 1 });
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
    expect(notifyRoleAssignmentChangeByEmail).not.toHaveBeenCalled();
  });
});
