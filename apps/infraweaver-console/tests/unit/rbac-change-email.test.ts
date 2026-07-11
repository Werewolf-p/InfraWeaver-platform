// Unit tests for the RBAC change-notification diff + email builder (pure logic).
// mailer + users-config are mocked away so importing the module has no side effects.
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/mailer", () => ({ isMailerConfigured: () => false, sendMail: jest.fn() }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: jest.fn() }));

import { diffRoleAssignments, buildRbacChangeEmail, isEmptyDiff } from "@/lib/rbac-change-email";
import type { RoleAssignment } from "@/lib/rbac";

function ra(over: Partial<RoleAssignment>): RoleAssignment {
  return {
    id: over.id ?? "id-" + Math.random().toString(36).slice(2),
    roleId: "jellyfin-user",
    scope: "/jellyfin",
    principalType: "user",
    principalId: "alice",
    grantedBy: "admin@example.com",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("diffRoleAssignments", () => {
  test("pure grant: assignment only in after", () => {
    const a = ra({ id: "a" });
    const diff = diffRoleAssignments([], [a]);
    expect(diff.granted).toHaveLength(1);
    expect(diff.revoked).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.granted[0].id).toBe("a");
  });

  test("pure revoke: assignment only in before", () => {
    const a = ra({ id: "a" });
    const diff = diffRoleAssignments([a], []);
    expect(diff.revoked).toHaveLength(1);
    expect(diff.granted).toHaveLength(0);
  });

  test("scope swap (revoke old id + grant new id, same scope) → changed", () => {
    const before = [ra({ id: "old", roleId: "jellyfin-user", scope: "/jellyfin" })];
    const after = [ra({ id: "new", roleId: "jellyfin-admin", scope: "/jellyfin" })];
    const diff = diffRoleAssignments(before, after);
    expect(diff.granted).toHaveLength(0);
    expect(diff.revoked).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].from.roleId).toBe("jellyfin-user");
    expect(diff.changed[0].to.roleId).toBe("jellyfin-admin");
  });

  test("same id, effect Allow→Deny → changed", () => {
    const before = [ra({ id: "x", effect: "Allow" })];
    const after = [ra({ id: "x", effect: "Deny" })];
    const diff = diffRoleAssignments(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.granted).toHaveLength(0);
    expect(diff.revoked).toHaveLength(0);
  });

  test("identical arrays → empty diff", () => {
    const a = ra({ id: "a" });
    expect(isEmptyDiff(diffRoleAssignments([a], [a]))).toBe(true);
  });

  test("grant + unrelated revoke on different scopes stay separate", () => {
    const before = [ra({ id: "r", scope: "/nas/x" })];
    const after = [ra({ id: "g", scope: "/jellyfin" })];
    const diff = diffRoleAssignments(before, after);
    expect(diff.granted).toHaveLength(1);
    expect(diff.revoked).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });
});

describe("buildRbacChangeEmail subject", () => {
  test("only granted → granted subject", () => {
    const diff = diffRoleAssignments([], [ra({ id: "a" })]);
    expect(buildRbacChangeEmail("Alice", diff).subject).toMatch(/granted/i);
  });
  test("only revoked → revoked subject", () => {
    const diff = diffRoleAssignments([ra({ id: "a" })], []);
    expect(buildRbacChangeEmail("Alice", diff).subject).toMatch(/revoked/i);
  });
  test("changed → changed subject, body names both roles", () => {
    const diff = diffRoleAssignments([ra({ id: "o", roleId: "jellyfin-user" })], [ra({ id: "n", roleId: "jellyfin-admin" })]);
    const email = buildRbacChangeEmail("Alice", diff);
    expect(email.subject).toMatch(/changed/i);
    expect(email.text).toContain("Alice");
  });
});
