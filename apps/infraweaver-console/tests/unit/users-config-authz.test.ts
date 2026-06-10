// `session-rbac` transitively imports `access-store`, which uses the
// `server-only` build-time marker. Jest can't resolve it; stub it out (same
// pattern as feedback-pipeline.test.ts).
jest.mock("server-only", () => ({}), { virtual: true });

// The functions under test (hasPermission / hasSessionPermission /
// hasAnySessionPermission) are pure. session-rbac only touches these server
// modules inside getSessionRBACContext, which these tests never call — so stub
// them out to avoid pulling the Kubernetes client (ESM Jest can't transform).
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/pim", () => ({ computeExtraPermissions: jest.fn(() => new Set()) }));
jest.mock("@/lib/users-config", () => ({ getRoleAssignmentsForSession: jest.fn() }));

import { hasPermission, type RoleAssignment } from "@/lib/rbac";
import {
  hasAnySessionPermission,
  hasSessionPermission,
  type SessionRBACContext,
} from "@/lib/session-rbac";

// Guards the intentional authorization design for users-config PUT/DELETE
// (api/users-config/[username]/route.ts), which is gated by `withAuth({
// permission: "users:write" })` at the default scope "/". `withAuth` resolves
// access through `hasAnySessionPermission -> hasSessionPermission`, so a
// principal granted `users:write` via a cluster-scoped role assignment or an
// active PIM elevation — NOT only via admin-group membership — is allowed to
// edit/delete users. These tests pin that behavior so a future refactor cannot
// silently narrow it back to a groups-only check.

const NOW = Date.now();
const isoIn = (ms: number) => new Date(NOW + ms).toISOString();

// platform-admin is a non-wildcard built-in role that includes "users:write".
// Using it (rather than platform-owner / "*") proves the grant comes from the
// role's explicit permission set, not a blanket wildcard.
function clusterScopedAdminAssignment(
  overrides: Partial<RoleAssignment> = {},
): RoleAssignment {
  return {
    id: "ra-1",
    roleId: "platform-admin",
    scope: "/",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: isoIn(-60_000),
    ...overrides,
  };
}

function context(overrides: Partial<SessionRBACContext> = {}): SessionRBACContext {
  return {
    groups: [],
    username: "alice",
    roleAssignments: [],
    extraPermissions: [],
    ...overrides,
  };
}

describe("users-config authorization (users:write at scope /)", () => {
  it("grants users:write via a cluster-scoped role assignment with no groups", () => {
    const assignment = clusterScopedAdminAssignment();

    // Core RBAC resolution (no group membership involved).
    expect(hasPermission([], "users:write", [assignment], "/", "alice")).toBe(true);

    // Exact path withAuth takes for users-config PUT/DELETE.
    const ctx = context({ roleAssignments: [assignment] });
    expect(hasSessionPermission(ctx, "users:write", "/")).toBe(true);
    expect(hasAnySessionPermission(ctx, ["users:write"], "/")).toBe(true);
  });

  it("grants users:write via an active PIM elevation (extraPermissions) with no groups or assignments", () => {
    const ctx = context({ extraPermissions: ["users:write"] });
    expect(hasSessionPermission(ctx, "users:write", "/")).toBe(true);
    expect(hasAnySessionPermission(ctx, ["users:write"], "/")).toBe(true);
  });

  it("does not require admin-group membership for the assignment-granted path", () => {
    const ctx = context({
      groups: [], // explicitly NOT in platform-admins
      roleAssignments: [clusterScopedAdminAssignment()],
    });
    expect(hasSessionPermission(ctx, "users:write", "/")).toBe(true);
  });

  it("rejects an expired role assignment", () => {
    const expired = clusterScopedAdminAssignment({ expiresAt: isoIn(-1_000) });
    expect(hasPermission([], "users:write", [expired], "/", "alice")).toBe(false);
    expect(hasSessionPermission(context({ roleAssignments: [expired] }), "users:write", "/")).toBe(false);
  });

  it("rejects a user-principal assignment belonging to a different user", () => {
    const forBob = clusterScopedAdminAssignment({ principalId: "bob" });
    const ctx = context({ username: "alice", roleAssignments: [forBob] });
    expect(hasSessionPermission(ctx, "users:write", "/")).toBe(false);
  });

  it("denies users:write when no group, assignment, or elevation grants it", () => {
    expect(hasSessionPermission(context(), "users:write", "/")).toBe(false);
  });
});
