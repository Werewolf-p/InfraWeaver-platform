import { computeDesiredAppUsers, type AccessGroup, type AccessUser } from "@/lib/app-accounts/policy";
import type { Permission, RoleAssignment } from "@/lib/rbac";

// The policy is app-agnostic: it takes the app's read/admin permission pair as
// parameters. We prove the mapping with EXISTING permissions (nas + wordpress) so
// the test never depends on a permission the rbac.ts edit hasn't landed yet — the
// exact point of the parameterization.
const READ: Permission = "nas:read";
const ADMIN: Permission = "nas:write";
const SCOPE = "/nas/truenas/media"; // any scope; storage roles carry nas:read/write

function grant(roleId: string, scope: string, over: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: `${roleId}@${scope}`,
    roleId,
    scope,
    principalType: "user",
    principalId: "",
    grantedBy: "remon",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("computeDesiredAppUsers", () => {
  const noGroups: Record<string, AccessGroup> = {};

  it("provisions a user granted read, as a standard user", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "alice@example.com", role_assignments: [grant("storage-viewer", SCOPE)] },
    };
    const result = computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups);
    expect(result.users).toEqual([{ username: "alice", email: "alice@example.com", role: "user" }]);
    expect(result.skippedNoEmail).toEqual([]);
  });

  it("maps the admin permission to an admin role", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "a@x.com", role_assignments: [grant("storage-viewer", SCOPE)] },
      boss: { email: "b@x.com", role_assignments: [grant("storage-contributor", SCOPE)] },
    };
    const result = computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups);
    expect(result.users).toEqual([
      { username: "alice", email: "a@x.com", role: "user" },
      { username: "boss", email: "b@x.com", role: "admin" },
    ]);
  });

  it("excludes a user with no grant at all", () => {
    const users: Record<string, AccessUser> = { bob: { email: "bob@x.com" } };
    expect(computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups).users).toEqual([]);
  });

  it("reports an authorized user who has no email rather than provisioning them", () => {
    const users: Record<string, AccessUser> = {
      alice: { role_assignments: [grant("storage-viewer", SCOPE)] }, // no email
    };
    const result = computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups);
    expect(result.users).toEqual([]);
    expect(result.skippedNoEmail).toEqual(["alice"]);
  });

  it("inherits a grant made on an ancestor scope", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "a@x.com", role_assignments: [grant("storage-viewer", "/nas/truenas")] },
      carol: { email: "c@x.com", role_assignments: [grant("storage-viewer", "/nas")] },
    };
    const result = computeDesiredAppUsers(`${SCOPE}/movies`, READ, ADMIN, users, noGroups);
    expect(result.users.map((u) => u.username)).toEqual(["alice", "carol"]);
  });

  it("does not leak a grant on a sibling scope", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "a@x.com", role_assignments: [grant("storage-viewer", "/nas/truenas/media-archive")] },
    };
    expect(computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups).users).toEqual([]);
  });

  it("resolves a grant made to a group the user belongs to", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "a@x.com", authentik_groups: ["media-team"] },
      bob: { email: "b@x.com", authentik_groups: ["other-team"] },
    };
    const groups: Record<string, AccessGroup> = {
      "media-team": { role_assignments: [grant("storage-contributor", SCOPE, { principalType: "group", principalId: "media-team" })] },
    };
    const result = computeDesiredAppUsers(SCOPE, READ, ADMIN, users, groups);
    expect(result.users).toEqual([{ username: "alice", email: "a@x.com", role: "admin" }]);
  });

  it("ignores an expired grant", () => {
    const users: Record<string, AccessUser> = {
      alice: { email: "a@x.com", role_assignments: [grant("storage-viewer", SCOPE, { expiresAt: "2020-01-01T00:00:00.000Z" })] },
    };
    expect(computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups).users).toEqual([]);
  });

  it("includes the platform owner, who holds `*` and needs no app-specific grant", () => {
    const users: Record<string, AccessUser> = {
      remon: { email: "remon@x.com", role_assignments: [grant("platform-owner", "/")] },
    };
    const result = computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups);
    expect(result.users).toEqual([{ username: "remon", email: "remon@x.com", role: "admin" }]);
  });

  it("sorts users for a stable, diff-friendly reconcile", () => {
    const users: Record<string, AccessUser> = {
      zoe: { email: "z@x.com", role_assignments: [grant("storage-viewer", SCOPE)] },
      amy: { email: "a@x.com", role_assignments: [grant("storage-viewer", SCOPE)] },
    };
    expect(computeDesiredAppUsers(SCOPE, READ, ADMIN, users, noGroups).users.map((u) => u.username)).toEqual(["amy", "zoe"]);
  });
});
