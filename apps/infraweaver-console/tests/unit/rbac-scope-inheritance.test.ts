import {
  BUILT_IN_ROLES,
  grantsForScope,
  isAllowed,
  isStrictAncestorScope,
  resolveRoleDefinition,
  scopeAncestors,
  scopeParent,
  ROOT_SCOPE,
  type Permission,
  type RbacSubject,
  type RoleAssignment,
} from "@/lib/rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// The Azure-style scoped-inheritance model: a role assigned on a scope inherits
// to every descendant scope. isAllowed resolves an action by walking from the
// resource scope up to the root; a grant on any ancestor satisfies the check.

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "ra",
    roleId: "reader",
    scope: ROOT_SCOPE,
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function subject(assignments: RoleAssignment[], overrides: Partial<RbacSubject> = {}): RbacSubject {
  return { groups: [], username: "alice", roleAssignments: assignments, ...overrides };
}

const WP_FOO = "/wordpress/sites/foo";
const WP_BAR = "/wordpress/sites/bar";

describe("scope hierarchy helpers", () => {
  it("scopeAncestors lists most-specific first, ending at root", () => {
    expect(scopeAncestors(WP_FOO)).toEqual([WP_FOO, "/wordpress/sites", "/wordpress", "/"]);
  });

  it("scopeAncestors normalizes a trailing slash", () => {
    expect(scopeAncestors("/game-hub/")).toEqual(["/game-hub", "/"]);
  });

  it("scopeParent returns the immediate parent and null at the root", () => {
    expect(scopeParent(WP_FOO)).toBe("/wordpress/sites");
    expect(scopeParent("/wordpress")).toBe(ROOT_SCOPE);
    expect(scopeParent(ROOT_SCOPE)).toBeNull();
  });

  it("isStrictAncestorScope is boundary-aware (foo does not cover foobar)", () => {
    expect(isStrictAncestorScope("/wordpress", WP_FOO)).toBe(true);
    expect(isStrictAncestorScope(WP_FOO, WP_FOO)).toBe(false);
    expect(isStrictAncestorScope(WP_FOO, "/wordpress/sites/foobar")).toBe(false);
  });
});

describe("isAllowed — Azure-style scope inheritance", () => {
  it("inherits a parent-scope grant down to a child resource", () => {
    const sub = subject([assignment({ roleId: "reader", scope: "/wordpress" })]);
    expect(isAllowed(sub, "wordpress:read", WP_FOO)).toBe(true);
    expect(isAllowed(sub, "wordpress:read", "/wordpress/sites")).toBe(true);
  });

  it("honors a direct grant on the exact resource scope", () => {
    const sub = subject([assignment({ roleId: "editor", scope: WP_FOO })]);
    expect(isAllowed(sub, "wordpress:write", WP_FOO)).toBe(true);
  });

  it("denies when no ancestor scope carries a matching grant", () => {
    const sub = subject([assignment({ roleId: "editor", scope: WP_FOO })]);
    // Sibling resource — the grant on foo must not leak to bar.
    expect(isAllowed(sub, "wordpress:read", WP_BAR)).toBe(false);
    // Parent scope is above the granted child — no upward inheritance.
    expect(isAllowed(sub, "wordpress:read", "/wordpress")).toBe(false);
  });

  it("does not leak across resource groups (wordpress grant ≠ game-hub access)", () => {
    const sub = subject([assignment({ roleId: "admin", scope: "/wordpress" })]);
    expect(isAllowed(sub, "game-hub:read", "/game-hub/servers/tmodloader")).toBe(false);
  });

  it("a root grant inherits everywhere", () => {
    const sub = subject([assignment({ roleId: "reader", scope: ROOT_SCOPE })]);
    expect(isAllowed(sub, "wordpress:read", WP_FOO)).toBe(true);
    expect(isAllowed(sub, "game-hub:read", "/game-hub/servers/tmodloader")).toBe(true);
  });

  it("owner ('*') is allowed for any action at any scope", () => {
    const sub = subject([assignment({ roleId: "owner", scope: "/game-hub" })]);
    expect(isAllowed(sub, "game-hub:admin", "/game-hub/servers/x")).toBe(true);
  });

  it("ignores an expired grant", () => {
    const sub = subject([
      assignment({ roleId: "reader", scope: "/wordpress", expiresAt: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(isAllowed(sub, "wordpress:read", WP_FOO)).toBe(false);
  });

  it("denies a principal with no groups and no assignments", () => {
    expect(isAllowed(subject([]), "apps:read", "/")).toBe(false);
  });
});

describe("grantsForScope — inherited vs direct classification", () => {
  it("tags an ancestor-scope grant as inherited and an exact grant as direct", () => {
    const sub = subject([
      assignment({ id: "parent", roleId: "reader", scope: "/wordpress" }),
      assignment({ id: "child", roleId: "editor", scope: WP_FOO }),
    ]);
    const grants = grantsForScope(sub, WP_FOO);
    const byId = Object.fromEntries(grants.map((g) => [g.assignment.id, g]));
    expect(byId.parent.inherited).toBe(true);
    expect(byId.child.inherited).toBe(false);
  });

  it("omits grants whose scope does not cover the queried scope", () => {
    const sub = subject([assignment({ roleId: "editor", scope: WP_BAR })]);
    expect(grantsForScope(sub, WP_FOO)).toHaveLength(0);
  });

  it("respects group principals (only members receive group grants)", () => {
    const groupGrant = assignment({ roleId: "reader", scope: "/wordpress", principalType: "group", principalId: "wp-team" });
    expect(grantsForScope(subject([groupGrant], { groups: ["wp-team"] }), WP_FOO)).toHaveLength(1);
    expect(grantsForScope(subject([groupGrant], { groups: [] }), WP_FOO)).toHaveLength(0);
  });
});

describe("generic Azure-style roles — resource tiers", () => {
  function perms(roleId: string): Set<Permission> {
    return new Set(resolveRoleDefinition(roleId)?.permissions ?? []);
  }

  it("reader has reads only, never writes", () => {
    const reader = perms("reader");
    expect(reader.has("wordpress:read")).toBe(true);
    expect(reader.has("wordpress:write")).toBe(false);
  });

  it("editor adds writes but not resource-admin", () => {
    const editor = perms("editor");
    expect(editor.has("wordpress:write")).toBe(true);
    expect(editor.has("wordpress:admin")).toBe(false);
  });

  it("admin adds resource-admin but never the escalation tier", () => {
    const admin = perms("admin");
    expect(admin.has("wordpress:admin")).toBe(true);
    expect(admin.has("*")).toBe(false);
    expect(admin.has("users:write")).toBe(false);
    expect(admin.has("rbac:admin")).toBe(false);
    expect(admin.has("cluster:admin")).toBe(false);
  });

  it("owner holds full control", () => {
    expect(BUILT_IN_ROLES.owner.permissions).toEqual(["*"]);
  });
});
