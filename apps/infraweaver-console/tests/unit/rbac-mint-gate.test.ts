// `session-rbac` transitively imports `access-store` (a `server-only` module)
// and the Kubernetes client. The functions exercised here are pure, so stub the
// server modules out — same pattern as users-config-authz.test.ts.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/pim", () => ({ computeExtraPermissions: jest.fn(() => new Set()) }));
jest.mock("@/lib/users-config", () => ({ getRoleAssignmentsForSession: jest.fn() }));

import {
  BUILT_IN_ROLES,
  getEffectivePermissions,
  type BuiltInRoleId,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import {
  hasAnySessionPermission,
  type SessionRBACContext,
} from "@/lib/session-rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// "Minting" users:write means causing a principal to gain the users:write
// permission. Across the role-management surface that can only happen by:
//   1. assigning a built-in role that *contains* users:write
//      (api/users-config/[username]/rbac POST, api/rbac/assignments POST), or
//   2. authoring a custom group whose permission set contains users:write
//      (api/groups POST/PATCH), which computeExtraPermissions folds into a
//      user's effective permissions cluster-wide.
//
// Every one of those write routes is gated on at least one of these
// "mint-gate" permissions:
const MINT_GATE_PERMISSIONS: Permission[] = ["users:write", "rbac:admin", "cluster:admin"];
//   - users-config/[username]/rbac POST  -> withAuth({ permission: "users:write" })
//   - rbac/assignments POST              -> any of ["users:write", "rbac:admin"]
//   - groups POST / groups/[id] PATCH    -> any of ["rbac:admin", "cluster:admin"]
//
// The intended invariant: only platform-owner and platform-admin may pass that
// gate. These tests pin it so a future role-definition change can't quietly let
// a lower-privileged role (operator, developer, viewer, game-*) mint users:write.

const PRIVILEGED_ROLES: BuiltInRoleId[] = ["platform-owner", "platform-admin"];
const ALL_BUILT_IN_ROLE_IDS = Object.keys(BUILT_IN_ROLES) as BuiltInRoleId[];

/** Effective permissions a user gains from holding `roleId` cluster-wide. */
function permsForRole(roleId: BuiltInRoleId): Set<Permission> {
  const assignment: RoleAssignment = {
    id: "ra-1",
    roleId,
    scope: "/",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: new Date().toISOString(),
  };
  return getEffectivePermissions([], "alice", [assignment], "/");
}

function context(overrides: Partial<SessionRBACContext> = {}): SessionRBACContext {
  return { groups: [], username: "alice", roleAssignments: [], extraPermissions: [], ...overrides };
}

function assignmentFor(roleId: BuiltInRoleId): RoleAssignment {
  return {
    id: "ra",
    roleId,
    scope: "/",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: new Date().toISOString(),
  };
}

describe("RBAC mint gate — only owner/admin can mint users:write", () => {
  it("only platform-owner and platform-admin confer users:write (literal or via *)", () => {
    // platform-owner holds "*" (which covers users:write); platform-admin holds
    // the literal permission. Mirror roleHasPermission semantics: "*" counts.
    const rolesWithUsersWrite = ALL_BUILT_IN_ROLE_IDS.filter((roleId) => {
      const perms = permsForRole(roleId);
      return perms.has("*") || perms.has("users:write");
    });
    expect(rolesWithUsersWrite.sort()).toEqual([...PRIVILEGED_ROLES].sort());
  });

  it("only platform-owner and platform-admin can pass the mint gate", () => {
    const rolesThatPassGate = ALL_BUILT_IN_ROLE_IDS.filter((roleId) => {
      const perms = permsForRole(roleId);
      return MINT_GATE_PERMISSIONS.some((p) => perms.has("*") || perms.has(p));
    });
    expect(rolesThatPassGate.sort()).toEqual([...PRIVILEGED_ROLES].sort());
  });

  it.each(PRIVILEGED_ROLES)("%s is allowed through the assignment-route gate", (roleId) => {
    const ctx = context({ roleAssignments: [assignmentFor(roleId)] });
    // Exact resolution path the routes take.
    expect(hasAnySessionPermission(ctx, ["users:write"], "/")).toBe(true);
    expect(hasAnySessionPermission(ctx, ["users:write", "rbac:admin"], "/")).toBe(true);
    expect(hasAnySessionPermission(ctx, ["rbac:admin", "cluster:admin"], "/")).toBe(true);
  });

  const NON_PRIVILEGED_ROLES = ALL_BUILT_IN_ROLE_IDS.filter((r) => !PRIVILEGED_ROLES.includes(r));

  it.each(NON_PRIVILEGED_ROLES)("%s is denied by every mint-gate variant", (roleId) => {
    const ctx = context({ roleAssignments: [assignmentFor(roleId)] });
    expect(hasAnySessionPermission(ctx, ["users:write"], "/")).toBe(false);
    expect(hasAnySessionPermission(ctx, ["users:write", "rbac:admin"], "/")).toBe(false);
    expect(hasAnySessionPermission(ctx, ["rbac:admin", "cluster:admin"], "/")).toBe(false);
  });

  it("denies a principal with no role, assignment, or elevation", () => {
    expect(hasAnySessionPermission(context(), ["users:write", "rbac:admin"], "/")).toBe(false);
    expect(hasAnySessionPermission(context(), ["rbac:admin", "cluster:admin"], "/")).toBe(false);
  });
});
