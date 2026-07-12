import {
  getEffectivePermissions,
  hasPermission,
  isAllowed,
  normalizeGroups,
  type RbacSubject,
  type RoleAssignment,
} from "@/lib/rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// Group names arriving on a session can carry surrounding whitespace (some SSO
// providers, undici header round-trips). RBAC matching is exact-string
// (`groups.includes(...)`, the users.yaml group-key lookup), so " platform-admins"
// used to resolve to zero permissions — an admin got a 403 on apps:read.
// normalizeGroups() trims the names at the session boundary so padded and clean
// group names are the same principal everywhere.

describe("normalizeGroups", () => {
  it("trims surrounding whitespace from each group name", () => {
    expect(normalizeGroups([" platform-admins", "wp-team\t"])).toEqual([
      "platform-admins",
      "wp-team",
    ]);
  });

  it("drops names that are empty after trimming", () => {
    expect(normalizeGroups(["  ", "", "platform-users"])).toEqual(["platform-users"]);
  });

  it("returns [] for undefined", () => {
    expect(normalizeGroups(undefined)).toEqual([]);
  });

  it("leaves already-clean names unchanged", () => {
    expect(normalizeGroups(["platform-admins"])).toEqual(["platform-admins"]);
  });
});

describe("whitespace-padded groups resolve permissions after normalize", () => {
  it("documents the gap: an untrimmed admin group resolves no apps:read", () => {
    // The bug, made explicit — exact-string match on " platform-admins" misses
    // the legacy admin group, so the member resolves 403.
    expect(hasPermission([" platform-admins"], "apps:read")).toBe(false);
  });

  it("normalized legacy admin group resolves apps:read (the fix)", () => {
    expect(hasPermission(normalizeGroups([" platform-admins"]), "apps:read")).toBe(true);
    // admin also expands to "*".
    expect(getEffectivePermissions(normalizeGroups([" platform-admins"]), "", []).has("*")).toBe(true);
  });

  it("normalized group principal matches a group role assignment", () => {
    const assignment: RoleAssignment = {
      id: "g1",
      roleId: "reader",
      scope: "/",
      principalType: "group",
      principalId: "platform-admins",
      grantedBy: "owner",
      grantedAt: "2026-01-01T00:00:00.000Z",
    };
    const raw: RbacSubject = {
      groups: [" platform-admins"],
      username: "alice",
      roleAssignments: [assignment],
    };
    // Untrimmed, the group principal never matches.
    expect(isAllowed(raw, "apps:read", "/")).toBe(false);
    // Trimmed at the session boundary, it does.
    expect(
      isAllowed({ ...raw, groups: normalizeGroups(raw.groups) }, "apps:read", "/"),
    ).toBe(true);
  });
});
