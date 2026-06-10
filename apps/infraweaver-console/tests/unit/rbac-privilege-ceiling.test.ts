// `session-rbac` transitively imports `access-store` (a `server-only` module)
// and the Kubernetes client. The functions exercised here are pure, so stub the
// server modules out — same pattern as rbac-mint-gate.test.ts.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/pim", () => ({ computeExtraPermissions: jest.fn(() => new Set()) }));
jest.mock("@/lib/users-config", () => ({ getRoleAssignmentsForSession: jest.fn() }));

import {
  BUILT_IN_ROLES,
  assignmentExceedsGranter,
  getEffectivePermissions,
  type BuiltInRoleId,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import {
  getSessionEffectivePermissions,
  type SessionRBACContext,
} from "@/lib/session-rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// The mint gate (rbac-mint-gate.test.ts) decides WHO can reach the two RBAC
// role-assignment POST routes. This guards WHAT a legitimately-gated granter may
// assign: they cannot grant a role conferring permissions they do not hold, so a
// platform-admin (no "*") cannot assign platform-owner ("*") — no admin→owner
// escalation.

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

describe("assignmentExceedsGranter — privilege ceiling on role assignment", () => {
  it("blocks platform-admin granting platform-owner (admin -> owner escalation)", () => {
    const granterPerms = permsForRole("platform-admin");
    expect(assignmentExceedsGranter(granterPerms, "platform-owner")).toBe(true);
  });

  it.each<BuiltInRoleId>(["platform-admin", "developer", "viewer"])(
    "allows platform-admin granting %s (within their own permissions)",
    (roleId) => {
      const granterPerms = permsForRole("platform-admin");
      expect(assignmentExceedsGranter(granterPerms, roleId)).toBe(false);
    },
  );

  it.each(Object.keys(BUILT_IN_ROLES) as BuiltInRoleId[])(
    "allows platform-owner (holds *) granting %s",
    (roleId) => {
      const granterPerms = permsForRole("platform-owner");
      expect(granterPerms.has("*")).toBe(true);
      expect(assignmentExceedsGranter(granterPerms, roleId)).toBe(false);
    },
  );

  it("blocks a narrow custom granter from granting a role with one extra permission", () => {
    // Granter is missing exactly one permission the target role (ops) confers.
    const granterPerms = new Set<Permission>(["apps:read", "cluster:read", "game-hub:read", "game-hub:players", "game-hub:stop"]);
    // ops = apps:read, cluster:read, game-hub:read, game-hub:players, game-hub:start, game-hub:stop
    expect(BUILT_IN_ROLES.ops.permissions).toContain("game-hub:start");
    expect(granterPerms.has("game-hub:start")).toBe(false);
    expect(assignmentExceedsGranter(granterPerms, "ops")).toBe(true);
  });

  it("allows when the granter holds every permission the target role confers", () => {
    const granterPerms = new Set<Permission>(BUILT_IN_ROLES.developer.permissions);
    expect(assignmentExceedsGranter(granterPerms, "developer")).toBe(false);
  });

  it("treats * in the target role as requiring * in granterPerms", () => {
    const granterPerms = new Set<Permission>(["users:write", "rbac:admin"]);
    expect(assignmentExceedsGranter(granterPerms, "platform-owner")).toBe(true);
  });

  it("ignores unknown roles (rejected earlier in the route)", () => {
    const granterPerms = new Set<Permission>(["apps:read"]);
    expect(assignmentExceedsGranter(granterPerms, "does-not-exist")).toBe(false);
  });
});

describe("getSessionEffectivePermissions — folds in PIM/custom-group extras", () => {
  it("includes role-assignment permissions", () => {
    const ctx = context({ roleAssignments: [assignmentFor("developer")] });
    const perms = getSessionEffectivePermissions(ctx, "/");
    expect(perms.has("apps:write")).toBe(true);
  });

  it("includes extraPermissions (active PIM / custom group elevations)", () => {
    const ctx = context({ extraPermissions: ["cluster:admin"] });
    const perms = getSessionEffectivePermissions(ctx, "/");
    expect(perms.has("cluster:admin")).toBe(true);
  });

  it("a platform-admin granter cannot escalate to owner even with their full effective set", () => {
    const ctx = context({ roleAssignments: [assignmentFor("platform-admin")] });
    const granterPerms = getSessionEffectivePermissions(ctx, "/");
    expect(assignmentExceedsGranter(granterPerms, "platform-owner")).toBe(true);
    expect(assignmentExceedsGranter(granterPerms, "platform-admin")).toBe(false);
  });
});
