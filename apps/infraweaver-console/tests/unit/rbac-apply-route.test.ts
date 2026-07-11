/**
 * @jest-environment node
 *
 * Route-level pins for PUT /api/rbac/assignments/apply.
 *
 * `rbac-apply-batch.test.ts` proves the applyRoleAssignments LIBRARY collapses a
 * role swap into one commit and one email. This file proves the ROUTE wires a
 * request body into that library correctly — the seam the library test can't see:
 *
 *   1. A GROUP body `{ principalType:"group", group, grants, revokes }` must reach
 *      applyRoleAssignments with `principal` = the GROUP name, never the username.
 *      The route accepts both `username` and `group`; picking the wrong one would
 *      write a user's assignments under a group's name (or vice-versa).
 *   2. A same-scope revoke+grant for a USER must fire exactly ONE notifyRbacChange
 *      email end-to-end (route → real applyRoleAssignments → mailer), so a role
 *      swap reads as a single "changed" notice, not a paired revoke + grant.
 *
 * The mailer, git store and downstream access-sync are mocked; the authorization
 * decision, body parsing/validation, principal derivation and the whole batch
 * apply (ceiling, dedup, before/after diff) are real.
 */

import type { RoleAssignment } from "@/lib/rbac";

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  NextRequest: class {},
}));

// Admin session with a "*" ceiling so every grant/revoke clears the privilege check
// (assignmentExceedsGranter short-circuits on "*"). The authorization gate itself is
// exercised: hasAnySessionPermission must return true for the route to proceed.
jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "owner@example.com" } })) }));
jest.mock("@/lib/session-rbac", () => ({
  getSessionRBACContext: jest.fn(async () => ({ groups: [], username: "owner", roleAssignments: [], extraPermissions: ["*"] })),
  getSessionEffectivePermissions: jest.fn(() => new Set(["*"])),
  hasAnySessionPermission: jest.fn(() => true),
}));

jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));

const loadUsersConfig = jest.fn();
const saveUsersConfig = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: (...args: unknown[]) => loadUsersConfig(...args),
  saveUsersConfig: (...args: unknown[]) => saveUsersConfig(...args),
  // Fixtures are already normalized, so pass the stored array straight through.
  normalizeRoleAssignments: (_u: string, raw: unknown) => raw ?? [],
  normalizeGroupRoleAssignments: (_g: string, raw: unknown) => raw ?? [],
}));

// Capture change-notice calls without sending mail. notifyRbacChange is a 1:1
// wrapper over this, so counting it counts the emails the call would send.
const notifyRoleAssignmentChangeByEmail = jest.fn();
jest.mock("@/lib/rbac-change-email", () => ({
  notifyRoleAssignmentChangeByEmail: (...args: unknown[]) => notifyRoleAssignmentChangeByEmail(...args),
}));

// Downstream identity reconcile is fire-and-forget dynamic-imported by the real
// applyRoleAssignments; stub the targets so no Authentik/Jellyfin/NAS work escapes.
jest.mock("@/lib/jellyfin/access", () => ({ reconcileJellyfinAccessWithRetry: jest.fn(async () => {}) }));
jest.mock("@/lib/nas/access", () => ({ syncShareAccess: jest.fn(async () => {}), syncStorageScopesUnder: jest.fn(async () => []) }));
jest.mock("@/addons/wordpress-manager/lib/access", () => ({ syncSiteAccess: jest.fn(async () => {}) }));

// Wrap the REAL applyRoleAssignments so the route runs it end-to-end (proving the
// one-email swap) while `mockApply` records exactly what the route passed it
// (proving the principal derivation). The var is `mock`-prefixed so the jest.mock
// factory may reference it.
const mockApply = jest.fn();
jest.mock("@/lib/rbac-assignments", () => {
  const actual = jest.requireActual("@/lib/rbac-assignments") as typeof import("@/lib/rbac-assignments");
  mockApply.mockImplementation((...args: Parameters<typeof actual.applyRoleAssignments>) => actual.applyRoleAssignments(...args));
  return { ...actual, applyRoleAssignments: (...args: unknown[]) => mockApply(...args) };
});

const { diffRoleAssignments } = jest.requireActual("@/lib/rbac-change-email") as typeof import("@/lib/rbac-change-email");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PUT } = require("@/app/api/rbac/assignments/apply/route");

function assignment(overrides: Partial<RoleAssignment> = {}): RoleAssignment {
  return {
    id: "ra-1",
    roleId: "jellyfin-user",
    scope: "/jellyfin",
    principalType: "user",
    principalId: "alice",
    grantedBy: "owner",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A NextRequest stand-in: the route only calls `req.json()`. */
function putReq(body: unknown) {
  return { json: async () => body } as never;
}

beforeEach(() => {
  loadUsersConfig.mockReset();
  saveUsersConfig.mockClear();
  notifyRoleAssignmentChangeByEmail.mockClear();
  mockApply.mockClear();
});

describe("PUT /api/rbac/assignments/apply — group body routes to the group principal", () => {
  it("passes the GROUP name as principal (never a username) to applyRoleAssignments", async () => {
    loadUsersConfig.mockResolvedValue({
      users: {},
      groups: {
        "media-team": {
          role_assignments: [assignment({ id: "g-old", roleId: "jellyfin-user", scope: "/jellyfin", principalType: "group", principalId: "media-team" })],
        },
      },
      sha: "sha-1",
    });

    const res = await PUT(
      putReq({
        principalType: "group",
        group: "media-team",
        grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }],
        revokes: ["g-old"],
      }),
    );

    expect(res.status).toBe(200);

    // The seam under test: principalType is "group" and principal is the GROUP
    // name — not the (absent) username, and not undefined.
    expect(mockApply).toHaveBeenCalledTimes(1);
    const applied = mockApply.mock.calls[0][0] as { principalType: string; principal: string; grants: unknown[]; revokes: string[] };
    expect(applied.principalType).toBe("group");
    expect(applied.principal).toBe("media-team");
    expect(applied.grants).toEqual([{ roleId: "jellyfin-admin", scope: "/jellyfin" }]);
    expect(applied.revokes).toEqual(["g-old"]);

    // The stored group is what got written — proving the group name flowed through
    // as the write key, not a user record.
    const savedGroups = saveUsersConfig.mock.calls[0][3] as Record<string, { role_assignments: RoleAssignment[] }>;
    expect(Object.keys(savedGroups)).toContain("media-team");
    expect(savedGroups["media-team"].role_assignments.map((a) => a.roleId)).toEqual(["jellyfin-admin"]);

    // Group principals fan out to many members, so they are intentionally not mailed.
    expect(notifyRoleAssignmentChangeByEmail).not.toHaveBeenCalled();
  });

  it("keys the batch on `group` even though the schema also accepts `username`", async () => {
    loadUsersConfig.mockResolvedValue({
      users: { "media-team": { email: "should-not-be-touched@x", role_assignments: [] } },
      groups: { "media-team": { role_assignments: [] } },
      sha: "sha-1",
    });

    await PUT(
      putReq({ principalType: "group", group: "media-team", grants: [{ roleId: "jellyfin-user", scope: "/jellyfin" }], revokes: [] }),
    );

    // The user record that happens to share the name must be left alone; only the
    // group section is rewritten.
    const savedUsers = saveUsersConfig.mock.calls[0][0] as Record<string, { role_assignments: RoleAssignment[] }>;
    expect(savedUsers["media-team"].role_assignments).toEqual([]);
    const savedGroups = saveUsersConfig.mock.calls[0][3] as Record<string, { role_assignments: RoleAssignment[] }>;
    expect(savedGroups["media-team"].role_assignments.map((a) => a.roleId)).toEqual(["jellyfin-user"]);
  });
});

describe("PUT /api/rbac/assignments/apply — same-scope swap sends exactly one email", () => {
  it("fires ONE notifyRbacChange for a user revoke+grant at the same scope", async () => {
    loadUsersConfig.mockResolvedValue({
      users: { alice: { email: "alice@x", name: "Alice", role_assignments: [assignment({ id: "old", roleId: "jellyfin-user", scope: "/jellyfin" })] } },
      groups: {},
      sha: "sha-1",
    });

    const res = await PUT(
      putReq({
        principalType: "user",
        username: "alice",
        grants: [{ roleId: "jellyfin-admin", scope: "/jellyfin" }],
        revokes: ["old"],
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, grantedCount: 1, revokedCount: 1 });

    // The route derived the user principal from `username`.
    const applied = mockApply.mock.calls[0][0] as { principalType: string; principal: string };
    expect(applied.principalType).toBe("user");
    expect(applied.principal).toBe("alice");

    // One commit and — the assertion that matters — exactly one change email.
    expect(saveUsersConfig).toHaveBeenCalledTimes(1);
    expect(notifyRoleAssignmentChangeByEmail).toHaveBeenCalledTimes(1);

    // …and its before/after collapses to a single "changed" line (old → new at the
    // same scope), which is what makes it one "changed" email rather than two notices.
    const { before, after } = notifyRoleAssignmentChangeByEmail.mock.calls[0][0] as { before: RoleAssignment[]; after: RoleAssignment[] };
    const diff = diffRoleAssignments(before, after);
    expect(diff.granted).toHaveLength(0);
    expect(diff.revoked).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].scope).toBe("/jellyfin");
    expect(diff.changed[0].from.roleId).toBe("jellyfin-user");
    expect(diff.changed[0].to.roleId).toBe("jellyfin-admin");
  });
});
