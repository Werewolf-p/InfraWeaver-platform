import {
  expandPermissionPattern,
  permissionMatches,
  roleHasPermission,
  type Permission,
  type RoleDefinition,
} from "@/lib/rbac";

// ── What this guards ─────────────────────────────────────────────────────────
// Action/prefix wildcards on the GRANTED side: "*", "<resource>:*", "*:<verb>".
// Requested actions stay concrete; only role permissions may use patterns so
// custom/admin roles need not enumerate every verb.

function role(permissions: RoleDefinition["permissions"], notActions?: Permission[]): RoleDefinition {
  return { id: "custom", name: "Custom", description: "", permissions, notActions, isBuiltIn: false };
}

describe("permissionMatches", () => {
  it("matches the global wildcard", () => {
    expect(permissionMatches("*", "apps:read")).toBe(true);
  });

  it("matches a resource wildcard within its resource only", () => {
    expect(permissionMatches("apps:*", "apps:read")).toBe(true);
    expect(permissionMatches("apps:*", "apps:delete")).toBe(true);
    expect(permissionMatches("apps:*", "config:read")).toBe(false);
  });

  it("matches a verb wildcard across resources only", () => {
    expect(permissionMatches("*:read", "apps:read")).toBe(true);
    expect(permissionMatches("*:read", "game-hub:read")).toBe(true);
    expect(permissionMatches("*:read", "apps:write")).toBe(false);
  });

  it("is boundary-aware on the resource separator", () => {
    expect(permissionMatches("game-hub:*", "game-hub:console")).toBe(true);
    expect(permissionMatches("game-hub:*", "game-hub-other:read" as Permission)).toBe(false);
  });

  it("still matches exact concrete permissions", () => {
    expect(permissionMatches("apps:read", "apps:read")).toBe(true);
    expect(permissionMatches("apps:read", "apps:write")).toBe(false);
  });
});

describe("expandPermissionPattern", () => {
  it("expands a resource wildcard to that resource's concrete verbs", () => {
    const expanded = expandPermissionPattern("game-hub:*");
    expect(expanded).toContain("game-hub:read");
    expect(expanded).toContain("game-hub:console");
    expect(expanded.every((p) => p.startsWith("game-hub:"))).toBe(true);
  });

  it("expands a verb wildcard to every resource's matching verb", () => {
    const expanded = expandPermissionPattern("*:read");
    expect(expanded).toContain("apps:read");
    expect(expanded).toContain("config:read");
    expect(expanded.every((p) => p.endsWith(":read"))).toBe(true);
  });

  it("keeps the global wildcard as a token and returns nothing for junk", () => {
    expect(expandPermissionPattern("*")).toEqual(["*"]);
    expect(expandPermissionPattern("bogus:token")).toEqual([]);
  });
});

describe("roleHasPermission with patterns and notActions", () => {
  it("resolves a resource wildcard role", () => {
    const r = role(["game-hub:*"]);
    expect(roleHasPermission(r, "game-hub:console")).toBe(true);
    expect(roleHasPermission(r, "apps:read")).toBe(false);
  });

  it("withholds a permission listed in notActions even under a wildcard", () => {
    const r = role(["*"], ["security:write"]);
    expect(roleHasPermission(r, "apps:read")).toBe(true);
    expect(roleHasPermission(r, "security:write")).toBe(false);
  });

  it("is unchanged for concrete-only roles", () => {
    const r = role(["apps:read", "apps:write"]);
    expect(roleHasPermission(r, "apps:read")).toBe(true);
    expect(roleHasPermission(r, "apps:delete")).toBe(false);
  });
});
