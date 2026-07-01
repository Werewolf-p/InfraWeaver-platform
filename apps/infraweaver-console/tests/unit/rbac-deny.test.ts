import {
  explainPermission,
  getEffectivePermissions,
  hasPermission,
  isAllowed,
  type RbacSubject,
  type RoleAssignment,
} from "@/lib/rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// Azure-style Deny assignments (effect: "Deny"). final = allow − deny, deny wins
// over allow AND over the legacy "*" admin grant. With no denies present the
// resolver keeps its exact prior behavior (pure back-compat).

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "ra",
    roleId: "admin",
    scope: "/",
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

describe("allow-only behavior is unchanged", () => {
  it("resolves a plain reader grant with no denies", () => {
    const perms = getEffectivePermissions([], "alice", [assignment({ roleId: "reader" })], "/");
    expect(perms.has("apps:read")).toBe(true);
    expect(perms.has("apps:write")).toBe(false);
    // No "*" materialization when there is no negation.
    expect(perms.has("*")).toBe(false);
  });

  it("keeps the legacy admin '*' token when there is no deny", () => {
    const perms = getEffectivePermissions(["platform-admins"], "alice", [], "/");
    expect(perms.has("*")).toBe(true);
  });
});

describe("deny overrides allow", () => {
  it("removes the denied read while keeping other admin perms", () => {
    const sub = subject([
      assignment({ id: "allow", roleId: "admin" }),
      assignment({ id: "deny", roleId: "reader", effect: "Deny" }),
    ]);
    expect(isAllowed(sub, "apps:write", "/")).toBe(true);
    expect(isAllowed(sub, "apps:read", "/")).toBe(false); // denied by the reader Deny
  });

  it("wins over a legacy '*' admin grant", () => {
    // platform-admins → legacy "*". A Deny of reader still carves reads out.
    expect(hasPermission(["platform-admins"], "security:write", [assignment({ roleId: "reader", effect: "Deny" })], "/", "alice")).toBe(true);
    expect(hasPermission(["platform-admins"], "security:read", [assignment({ roleId: "reader", effect: "Deny" })], "/", "alice")).toBe(false);
  });

  it("only applies the deny within its scope subtree", () => {
    const sub = subject([
      assignment({ id: "allow", roleId: "admin", scope: "/" }),
      assignment({ id: "deny", roleId: "reader", effect: "Deny", scope: "/wordpress" }),
    ]);
    expect(isAllowed(sub, "apps:read", "/wordpress/sites/foo")).toBe(false); // under the deny
    expect(isAllowed(sub, "apps:read", "/game-hub")).toBe(true); // outside the deny subtree
  });
});

describe("explainPermission", () => {
  it("explains an allow with the deciding assignment", () => {
    const result = explainPermission([], "alice", [assignment({ id: "a1", roleId: "admin" })], "apps:write", "/");
    expect(result.allowed).toBe(true);
    expect(result.effect).toBe("Allow");
    expect(result.decidingAssignments.map((a) => a.id)).toEqual(["a1"]);
  });

  it("explains a deny and reports the deny assignment as deciding", () => {
    const result = explainPermission(
      [],
      "alice",
      [assignment({ id: "allow", roleId: "admin" }), assignment({ id: "deny", roleId: "reader", effect: "Deny" })],
      "apps:read",
      "/",
    );
    expect(result.allowed).toBe(false);
    expect(result.effect).toBe("Deny");
    expect(result.decidingAssignments.map((a) => a.id)).toEqual(["deny"]);
  });

  it("reports NotApplicable when nothing grants or denies the action", () => {
    const result = explainPermission([], "alice", [], "apps:read", "/");
    expect(result.allowed).toBe(false);
    expect(result.effect).toBe("NotApplicable");
    expect(result.decidingAssignments).toEqual([]);
  });
});
