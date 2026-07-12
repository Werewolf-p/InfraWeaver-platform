// Pins the scope-aware privilege ceiling (rbac-assignments AssignmentActionContext
// now carries granterPermsAt(scope), not a flat granterPerms at "/"). Evaluating
// the granter's effective permissions AT the grant's scope means a Deny scoped to
// a subtree lowers the ceiling there — so a granter cannot grant back permissions
// their own subtree-Deny withholds. Before the fix the ceiling was computed at "/"
// only, blind to a subtree Deny.

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));

const loadUsersConfig = jest.fn();
const saveUsersConfig = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: (...args: unknown[]) => loadUsersConfig(...args),
  saveUsersConfig: (...args: unknown[]) => saveUsersConfig(...args),
  normalizeRoleAssignments: (_u: string, raw: unknown) => raw ?? [],
  normalizeGroupRoleAssignments: (_g: string, raw: unknown) => raw ?? [],
}));
jest.mock("@/lib/rbac-change-email", () => ({
  notifyRoleAssignmentChangeByEmail: jest.fn(),
}));

import { getEffectivePermissions, type BuiltInRoleId, type Permission, type RoleAssignment } from "@/lib/rbac";
import { grantRoleAssignment } from "@/lib/rbac-assignments";

function permsForRole(roleId: BuiltInRoleId): Set<Permission> {
  const a: RoleAssignment = {
    id: "granter-ra", roleId, scope: "/", principalType: "user",
    principalId: "actor", grantedBy: "system", grantedAt: "2026-01-01T00:00:00.000Z",
  };
  return getEffectivePermissions([], "actor", [a], "/");
}

function fileWithUser() {
  return { users: { alice: { email: "alice@x", name: "Alice", role_assignments: [] } }, groups: {}, sha: "sha-1" };
}

// Full owner-level perms everywhere EXCEPT /jellyfin, where the granter is Denied
// (empty set) — models a "*" granter carrying an explicit Deny scoped to /jellyfin.
const deniedAtJellyfin = (scope: string): Set<Permission> =>
  scope === "/jellyfin" ? new Set<Permission>() : permsForRole("platform-owner");

beforeEach(() => {
  loadUsersConfig.mockReset().mockResolvedValue(fileWithUser());
  saveUsersConfig.mockClear();
});

describe("scope-aware privilege ceiling", () => {
  it("evaluates the ceiling at the grant's scope, not at '/'", async () => {
    const seen: string[] = [];
    await grantRoleAssignment(
      { roleId: "jellyfin-user", scope: "/jellyfin", principalType: "user", principal: "alice" },
      { granterPermsAt: (scope) => { seen.push(scope); return permsForRole("platform-owner"); }, actor: "a@x" },
    );
    expect(seen).toContain("/jellyfin");
    expect(seen).not.toContain("/");
  });

  it("rejects a grant at a scope where the granter's scoped permissions do not cover it (subtree Deny)", async () => {
    const res = await grantRoleAssignment(
      { roleId: "jellyfin-user", scope: "/jellyfin", principalType: "user", principal: "alice" },
      { granterPermsAt: deniedAtJellyfin, actor: "a@x" },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("allows the same grant at a scope where the granter is NOT denied", async () => {
    const res = await grantRoleAssignment(
      { roleId: "jellyfin-user", scope: "/", principalType: "user", principal: "alice" },
      { granterPermsAt: deniedAtJellyfin, actor: "a@x" },
    );
    expect(res.ok).toBe(true);
  });
});
