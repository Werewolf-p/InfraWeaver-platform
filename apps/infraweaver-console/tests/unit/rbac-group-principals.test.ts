import {
  getEffectivePermissions,
  grantsForScope,
  isAllowed,
  type RbacSubject,
  type RoleAssignment,
} from "@/lib/rbac";
import { normalizeGroupRoleAssignments } from "@/lib/users-config";

// ── What this guards ─────────────────────────────────────────────────────────
// Group-principal role assignments. Previously a "group" assignment was stored
// with principalId = username, so getEffectivePermissions' group filter
// (`groups.includes(principalId)`) could never match a real Authentik group.
// Group assignments now name the GROUP as principal and are merged into the
// session's role assignments, so every member inherits them.

function groupAssignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "g1",
    roleId: "editor",
    scope: "/wordpress",
    principalType: "group",
    principalId: "wp-team",
    grantedBy: "owner",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function subject(assignments: RoleAssignment[], overrides: Partial<RbacSubject> = {}): RbacSubject {
  return { groups: [], username: "alice", roleAssignments: assignments, ...overrides };
}

describe("normalizeGroupRoleAssignments", () => {
  it("stamps every assignment with the group as principal", () => {
    const normalized = normalizeGroupRoleAssignments("wp-team", [
      { id: "x", roleId: "reader", scope: "/wordpress", principalType: "user", principalId: "alice", grantedBy: "o", grantedAt: "t" },
    ]);
    expect(normalized[0].principalType).toBe("group");
    expect(normalized[0].principalId).toBe("wp-team");
  });

  it("returns [] for an undefined assignment list", () => {
    expect(normalizeGroupRoleAssignments("wp-team")).toEqual([]);
  });
});

describe("group-principal resolution", () => {
  it("grants a group's role to a member session", () => {
    const sub = subject([groupAssignment()], { groups: ["wp-team"] });
    expect(isAllowed(sub, "wordpress:write", "/wordpress")).toBe(true);
  });

  it("inherits a group grant down the scope tree", () => {
    const sub = subject([groupAssignment({ roleId: "reader" })], { groups: ["wp-team"] });
    expect(isAllowed(sub, "wordpress:read", "/wordpress/sites/foo")).toBe(true);
  });

  it("leaves a non-member unaffected", () => {
    const sub = subject([groupAssignment()], { groups: ["other-team"] });
    expect(isAllowed(sub, "wordpress:write", "/wordpress")).toBe(false);
    expect(getEffectivePermissions(["other-team"], "bob", [groupAssignment()], "/wordpress").has("wordpress:write")).toBe(false);
  });

  it("grantsForScope tags the group grant for a member only", () => {
    const grant = groupAssignment({ roleId: "reader" });
    expect(grantsForScope(subject([grant], { groups: ["wp-team"] }), "/wordpress/sites/foo")).toHaveLength(1);
    expect(grantsForScope(subject([grant], { groups: [] }), "/wordpress/sites/foo")).toHaveLength(0);
  });

  it("leaves existing user-based resolution unchanged", () => {
    const userGrant = groupAssignment({ id: "u1", principalType: "user", principalId: "alice", roleId: "reader", scope: "/wordpress" });
    const sub = subject([userGrant], { groups: [], username: "alice" });
    expect(isAllowed(sub, "wordpress:read", "/wordpress/sites/foo")).toBe(true);
    // A different user is not affected by alice's user grant.
    expect(isAllowed(subject([userGrant], { groups: [], username: "bob" }), "wordpress:read", "/wordpress")).toBe(false);
  });
});
