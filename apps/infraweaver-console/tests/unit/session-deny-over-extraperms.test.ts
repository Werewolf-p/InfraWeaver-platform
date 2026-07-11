// Pins the fix for "Deny cannot subtract extraPermissions": hasSessionPermission
// short-circuited true on custom-group/PIM extraPermissions BEFORE consulting an
// explicit Deny. A scoped Deny must win over an extraPermission grant.

jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/access-store", () => ({ getAccessState: jest.fn() }));
jest.mock("@/lib/pim", () => ({ computeExtraPermissions: jest.fn(() => new Set()) }));
jest.mock("@/lib/users-config", () => ({
  getRoleAssignmentsForSession: jest.fn(),
  getGroupRoleAssignmentsForSession: jest.fn(),
}));

import { hasSessionPermission } from "@/lib/session-rbac";
import type { Permission, RoleAssignment } from "@/lib/rbac";

const denyJellyfin: RoleAssignment = {
  id: "deny-1", roleId: "jellyfin-user", scope: "/jellyfin", effect: "Deny",
  principalType: "user", principalId: "alice", grantedBy: "admin", grantedAt: "2026-01-01T00:00:00.000Z",
};

const ctx = (roleAssignments: RoleAssignment[], extraPermissions: Permission[]) => ({
  groups: [], username: "alice", roleAssignments, extraPermissions,
});

describe("hasSessionPermission — Deny wins over extraPermissions", () => {
  it("returns false when an explicit Deny covers the scope, even though an extraPermission grants it", () => {
    expect(hasSessionPermission(ctx([denyJellyfin], ["jellyfin:read"]), "jellyfin:read", "/jellyfin")).toBe(false);
  });

  it("still honors the extraPermission at a scope the Deny does not cover", () => {
    expect(hasSessionPermission(ctx([denyJellyfin], ["jellyfin:read"]), "jellyfin:read", "/")).toBe(true);
  });

  it("a wildcard extraPermission is likewise overridden by a covering Deny", () => {
    expect(hasSessionPermission(ctx([denyJellyfin], ["*"]), "jellyfin:read", "/jellyfin")).toBe(false);
  });

  it("grants via extraPermission when there is no Deny at all", () => {
    expect(hasSessionPermission(ctx([], ["jellyfin:read"]), "jellyfin:read", "/jellyfin")).toBe(true);
  });
});
