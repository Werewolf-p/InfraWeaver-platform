/**
 * Pure-logic pins for the "grant existing Authentik user" feature:
 *   - WordPress role → InfraWeaver RBAC role mapping (all five roles).
 *   - The idempotent `ensure-user` pre-create command (the dupe/link SKIP path):
 *     it must GUARD on existence before creating, so a user who already exists by
 *     login or email is never re-created (first SSO login links by email instead).
 *   - Authentik picker row shaping (active + has-email filter, sort).
 *   - Access-policy authorization: a per-site WordPress grant makes the user one of
 *     the site's authorized SSO users.
 *
 * `server-only` is stubbed by the jest moduleNameMapper, so the action module (which
 * imports it) loads directly.
 */

// The action module transitively imports provision.ts → @kubernetes/client-node
// (ESM, untransformed by jest). `commandFor`/`manageActionSchema` are pure and never
// touch those, so stub the heavy leaves out to keep this a fast pure-logic test.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@kubernetes/client-node", () => ({}));
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({}));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({}));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({}));
// actions.ts now routes set-maintenance-mode through the orchestrator (which pulls
// in the signed-op + provision graph) — stub it so this pure-logic test stays light.
jest.mock("@/addons/wordpress-manager/lib/maintenance-orchestrator", () => ({ setSiteMaintenance: jest.fn() }));

import { commandFor, manageActionSchema } from "@/addons/wordpress-manager/lib/manage/actions";
import {
  wpRoleToRbacRoleId,
  isAdminTierWpRole,
  asWordpressRole,
} from "@/addons/wordpress-manager/lib/manage/wp-role-mapping";
import { mapAuthentikUsers } from "@/addons/wordpress-manager/lib/authentik-users";
import { computeSiteAccessUsers, type AccessUser } from "@/addons/wordpress-manager/lib/access-policy";
import type { RoleAssignment } from "@/lib/rbac";

describe("wpRoleToRbacRoleId — every WordPress role maps to an RBAC tier that confers site access", () => {
  it("maps administrator to the admin RBAC role", () => {
    expect(wpRoleToRbacRoleId("administrator")).toBe("wordpress-admin");
  });

  it("maps publish-capable content roles (editor, author) to the editor/write tier", () => {
    expect(wpRoleToRbacRoleId("editor")).toBe("wordpress-editor");
    expect(wpRoleToRbacRoleId("author")).toBe("wordpress-editor");
  });

  it("maps non-publishing roles (contributor, subscriber) to the viewer/read tier", () => {
    expect(wpRoleToRbacRoleId("contributor")).toBe("wordpress-viewer");
    expect(wpRoleToRbacRoleId("subscriber")).toBe("wordpress-viewer");
  });

  it("flags only administrator as admin-tier (the rbac:admin-gated role)", () => {
    expect(isAdminTierWpRole("administrator")).toBe(true);
    for (const role of ["editor", "author", "contributor", "subscriber"] as const) {
      expect(isAdminTierWpRole(role)).toBe(false);
    }
  });

  it("narrows unknown strings to null", () => {
    expect(asWordpressRole("administrator")).toBe("administrator");
    expect(asWordpressRole("superadmin")).toBeNull();
    expect(asWordpressRole("")).toBeNull();
  });
});

describe("ensure-user action — idempotent pre-create (dupe/link skip path)", () => {
  it("is accepted by the allow-listed action schema", () => {
    const parsed = manageActionSchema.safeParse({
      type: "ensure-user",
      login: "jane.doe",
      email: "jane@example.com",
      role: "author",
    });
    expect(parsed.success).toBe(true);
  });

  it("guards on existence by BOTH login and email before creating (skips a duplicate)", () => {
    const built = commandFor({ type: "ensure-user", login: "jane", email: "jane@example.com", role: "author" });
    expect(built).not.toBeNull();
    const cmd = built!.command;
    // Existence is checked (so an existing account is left for the OIDC email link)…
    expect(cmd).toContain("user get jane");
    expect(cmd).toContain("user get jane@example.com");
    // …and creation only happens in the else branch, with the exact chosen role.
    expect(cmd).toMatch(/else .*user create jane jane@example\.com --role=author/);
    // A generated password is minted in-pod — never passed on the command line.
    expect(cmd).toContain("/dev/urandom");
  });

  it("rejects a role outside the allow-list", () => {
    const parsed = manageActionSchema.safeParse({
      type: "ensure-user",
      login: "jane",
      email: "jane@example.com",
      role: "superadmin",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("mapAuthentikUsers — picker rows are active, email-bearing, and sorted", () => {
  it("drops inactive users and users without an email, and sorts by username", () => {
    const rows = mapAuthentikUsers([
      { username: "zed", email: "zed@x.com", name: "Zed", is_active: true },
      { username: "amy", email: "amy@x.com", name: "Amy" },
      { username: "noemail", email: "", name: "No Email", is_active: true },
      { username: "inactive", email: "in@x.com", is_active: false },
      { username: "", email: "blank@x.com", is_active: true },
    ]);
    expect(rows.map((r) => r.username)).toEqual(["amy", "zed"]);
    // name falls back to username when absent.
    expect(rows.find((r) => r.username === "amy")?.name).toBe("Amy");
  });
});

describe("computeSiteAccessUsers — a per-site WordPress grant authorizes SSO", () => {
  function grant(principal: string, scope: string, roleId = "wordpress-viewer"): RoleAssignment {
    return {
      id: `ra-${principal}`,
      roleId,
      scope,
      principalType: "user",
      principalId: principal,
      grantedBy: "owner",
      grantedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("includes a user with a viewer grant scoped to the site, excludes an unrelated-site grant", () => {
    const users: Record<string, AccessUser> = {
      jane: { email: "jane@example.com", role_assignments: [grant("jane", "/wordpress/sites/blog")] },
      otto: { email: "otto@example.com", role_assignments: [grant("otto", "/wordpress/sites/shop")] },
      nobody: { email: "nobody@example.com", role_assignments: [] },
    };
    const allowed = computeSiteAccessUsers("blog", users, {});
    expect(allowed).toContain("jane");
    expect(allowed).not.toContain("otto");
    expect(allowed).not.toContain("nobody");
  });
});
