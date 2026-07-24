/**
 * @jest-environment node
 *
 * Integration pins for grantWordpressSiteAccess — the service the POST
 * /api/wordpress/sites/[site]/grant route delegates to. It coordinates the two
 * writes the feature needs and enforces the ceilings:
 *
 *   1. Ensures a users.yaml record exists (a user-principal grant 404s without one).
 *   2. Grants the site-scoped RBAC role via the shared grantRoleAssignment (which
 *      owns the RBAC privilege ceiling, audit + downstream reconcile — mocked here).
 *   3. Idempotently pre-creates the WordPress account with the EXACT chosen role via
 *      the signed `ensure-user` manage action — NON-FATAL if the pod is unavailable.
 *
 * The git store, RBAC grant helper and manage-action exec are mocked; the service's
 * own orchestration, mapping, ceiling and idempotency are real.
 */

jest.mock("server-only", () => ({}), { virtual: true });

const loadUsersConfig = jest.fn();
const saveUsersConfig = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: (...args: unknown[]) => loadUsersConfig(...args),
  saveUsersConfig: (...args: unknown[]) => saveUsersConfig(...args),
  findUserByIdentity: (
    users: Record<string, { email?: string }>,
    identity: { username?: string; email?: string },
  ) => {
    if (identity.username && users[identity.username]) return { username: identity.username, user: users[identity.username] };
    if (identity.email) {
      const match = Object.entries(users).find(([, u]) => u.email === identity.email);
      if (match) return { username: match[0], user: match[1] };
    }
    return null;
  },
}));

const grantRoleAssignment = jest.fn();
jest.mock("@/lib/rbac-assignments", () => ({
  grantRoleAssignment: (...args: unknown[]) => grantRoleAssignment(...args),
}));

const runManageAction = jest.fn();
jest.mock("@/addons/wordpress-manager/lib/manage/actions", () => ({
  runManageAction: (...args: unknown[]) => runManageAction(...args),
}));

import { grantWordpressSiteAccess } from "@/addons/wordpress-manager/lib/grant-authentik-user";
import { AddonHttpError } from "@/addons/wordpress-manager/lib/errors";
import type { Permission } from "@/lib/rbac";

const OWNER_CTX = { granterPermsAt: (): Set<Permission> => new Set<Permission>(["*"]), actor: "owner@example.com" };
const ADMIN_OPTS = { callerHasRbacAdmin: true };

function withUser() {
  loadUsersConfig.mockResolvedValue({
    users: { jane: { email: "jane@example.com", name: "Jane", role_assignments: [] } },
    groups: {},
    sha: "sha-1",
  });
}

beforeEach(() => {
  loadUsersConfig.mockReset();
  saveUsersConfig.mockClear();
  grantRoleAssignment.mockReset();
  runManageAction.mockReset();
  grantRoleAssignment.mockResolvedValue({ ok: true, assignment: { id: "ra-1" } });
  runManageAction.mockResolvedValue({ ok: true, message: "WordPress account ensured." });
});

describe("grantWordpressSiteAccess — happy path", () => {
  it("grants the mapped RBAC role at the site scope and pre-creates the account by email", async () => {
    withUser();

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "jane", email: "jane@example.com", name: "Jane", wpRole: "author" },
      OWNER_CTX,
      ADMIN_OPTS,
    );

    expect(result).toMatchObject({ ok: true, rbac: "granted", wpAccount: "ensured", roleId: "wordpress-editor", wpRole: "author" });

    // The RBAC grant is scoped to THIS site and uses the mapped role + user principal.
    expect(grantRoleAssignment).toHaveBeenCalledTimes(1);
    const grantArg = grantRoleAssignment.mock.calls[0][0];
    expect(grantArg).toEqual({
      roleId: "wordpress-editor",
      scope: "/wordpress/sites/blog",
      principalType: "user",
      principal: "jane",
      effect: "Allow",
    });

    // The signed pre-create uses the EXACT chosen role + the resolved email.
    expect(runManageAction).toHaveBeenCalledWith("blog", {
      type: "ensure-user",
      login: "jane",
      email: "jane@example.com",
      role: "author",
    });

    // Record already existed → no extra users.yaml write for provisioning.
    expect(saveUsersConfig).not.toHaveBeenCalled();
  });

  it("provisions a users.yaml record first when the grantee has none", async () => {
    loadUsersConfig.mockResolvedValue({ users: {}, groups: {}, sha: "sha-1" });

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "newbie", email: "newbie@example.com", name: "New Bie", wpRole: "subscriber" },
      OWNER_CTX,
      ADMIN_OPTS,
    );

    expect(result.ok).toBe(true);
    // Minimal record created under the Authentik username before the grant.
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
    const savedUsers = saveUsersConfig.mock.calls[0][0] as Record<string, { email: string; name: string }>;
    expect(savedUsers.newbie).toEqual({ name: "New Bie", email: "newbie@example.com" });
    expect(grantRoleAssignment.mock.calls[0][0]).toMatchObject({ roleId: "wordpress-viewer", principal: "newbie" });
  });
});

describe("grantWordpressSiteAccess — idempotency", () => {
  it("treats an existing identical RBAC grant (409) as already-granted and still ensures the account", async () => {
    withUser();
    grantRoleAssignment.mockResolvedValue({ ok: false, status: 409, error: "Assignment already exists" });

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "jane", email: "jane@example.com", name: "Jane", wpRole: "editor" },
      OWNER_CTX,
      ADMIN_OPTS,
    );

    expect(result).toMatchObject({ ok: true, rbac: "already-granted", wpAccount: "ensured" });
    expect(runManageAction).toHaveBeenCalledTimes(1);
  });

  it("keeps the grant when the pod-side pre-create is unavailable (deferred, non-fatal)", async () => {
    withUser();
    runManageAction.mockRejectedValue(new AddonHttpError("WordPress pod is not running yet", 503));

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "jane", email: "jane@example.com", name: "Jane", wpRole: "editor" },
      OWNER_CTX,
      ADMIN_OPTS,
    );

    expect(result).toMatchObject({ ok: true, rbac: "granted", wpAccount: "deferred" });
    expect((result as { wpAccountNote?: string }).wpAccountNote).toContain("pod is not running");
  });
});

describe("grantWordpressSiteAccess — privilege ceilings (rejections)", () => {
  it("rejects administrator-tier access when the caller lacks rbac:admin, before any write", async () => {
    withUser();

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "jane", email: "jane@example.com", name: "Jane", wpRole: "administrator" },
      OWNER_CTX,
      { callerHasRbacAdmin: false },
    );

    expect(result).toEqual({ ok: false, status: 403, error: expect.stringContaining("rbac:admin") });
    expect(grantRoleAssignment).not.toHaveBeenCalled();
    expect(saveUsersConfig).not.toHaveBeenCalled();
    expect(runManageAction).not.toHaveBeenCalled();
  });

  it("propagates the RBAC privilege-ceiling rejection and never pre-creates the account", async () => {
    withUser();
    grantRoleAssignment.mockResolvedValue({ ok: false, status: 403, error: "Cannot grant a role that exceeds your own permissions" });

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "jane", email: "jane@example.com", name: "Jane", wpRole: "administrator" },
      { granterPermsAt: (): Set<Permission> => new Set<Permission>(["wordpress:read"]), actor: "scoped@example.com" },
      ADMIN_OPTS,
    );

    expect(result).toEqual({ ok: false, status: 403, error: "Cannot grant a role that exceeds your own permissions" });
    expect(runManageAction).not.toHaveBeenCalled();
  });

  it("rejects a username that is not a valid WordPress login before writing", async () => {
    withUser();

    const result = await grantWordpressSiteAccess(
      { site: "blog", username: "bad user!", email: "x@example.com", name: "X", wpRole: "subscriber" },
      OWNER_CTX,
      ADMIN_OPTS,
    );

    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(grantRoleAssignment).not.toHaveBeenCalled();
  });
});
