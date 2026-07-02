import { computeSiteAccessUsers, type AccessUser, type AccessGroup } from "@/addons/wordpress-manager/lib/access-policy";
import type { RoleAssignment } from "@/lib/rbac";

/** Minimal RoleAssignment builder — only the fields the resolver reads matter. */
function grant(partial: Partial<RoleAssignment> & Pick<RoleAssignment, "roleId" | "scope">): RoleAssignment {
  return {
    id: partial.id ?? `${partial.roleId}-${partial.scope}`,
    principalType: partial.principalType ?? "user",
    principalId: partial.principalId ?? "",
    grantedBy: "tester",
    grantedAt: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

describe("computeSiteAccessUsers", () => {
  test("includes a user with a per-site grant, excludes them from other sites", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant({ roleId: "wordpress-viewer", scope: "/wordpress/sites/blog", principalId: "alice" })] },
    };
    expect(computeSiteAccessUsers("blog", users, {})).toEqual(["alice"]);
    expect(computeSiteAccessUsers("shop", users, {})).toEqual([]);
  });

  test("includes a user with an all-sites (/wordpress) grant on every site", () => {
    const users: Record<string, AccessUser> = {
      bob: { role_assignments: [grant({ roleId: "wordpress-admin", scope: "/wordpress", principalId: "bob" })] },
    };
    expect(computeSiteAccessUsers("blog", users, {})).toEqual(["bob"]);
    expect(computeSiteAccessUsers("shop", users, {})).toEqual(["bob"]);
  });

  test("includes a platform admin (holds *) via legacy group role", () => {
    const users: Record<string, AccessUser> = {
      root: { authentik_groups: ["platform-admins"] },
    };
    expect(computeSiteAccessUsers("blog", users, {})).toEqual(["root"]);
  });

  test("resolves a group-principal grant for members of that group only", () => {
    const users: Record<string, AccessUser> = {
      carol: { authentik_groups: ["editors"] },
      dave: { authentik_groups: ["viewers"] },
    };
    const groups: Record<string, AccessGroup> = {
      editors: { role_assignments: [grant({ roleId: "wordpress-editor", scope: "/wordpress/sites/blog", principalType: "group", principalId: "editors" })] },
    };
    expect(computeSiteAccessUsers("blog", users, groups)).toEqual(["carol"]);
  });

  test("excludes an expired grant", () => {
    const users: Record<string, AccessUser> = {
      eve: { role_assignments: [grant({ roleId: "wordpress-viewer", scope: "/wordpress/sites/blog", principalId: "eve", expiresAt: "2020-01-01T00:00:00Z" })] },
    };
    expect(computeSiteAccessUsers("blog", users, {})).toEqual([]);
  });

  test("excludes a user with no WordPress grant, and returns a sorted list", () => {
    const users: Record<string, AccessUser> = {
      zoe: { role_assignments: [grant({ roleId: "wordpress-viewer", scope: "/wordpress/sites/blog", principalId: "zoe" })] },
      amy: { role_assignments: [grant({ roleId: "wordpress-viewer", scope: "/wordpress/sites/blog", principalId: "amy" })] },
      noone: { role_assignments: [grant({ roleId: "game-server-viewer", scope: "/game-hub/servers/x", principalId: "noone" })] },
    };
    expect(computeSiteAccessUsers("blog", users, {})).toEqual(["amy", "zoe"]);
  });
});
