jest.mock("server-only", () => ({}), { virtual: true });

let mockAkUsers: Array<{ pk: number; username: string; name?: string; email?: string; attributes?: Record<string, unknown> }> = [];
const mockAkFetch = jest.fn(async (path: string, opts?: { method?: string }) => {
  if (!opts?.method || opts.method === "GET") {
    return { ok: true, json: async () => ({ results: mockAkUsers }) };
  }
  return { ok: true, json: async () => ({}) }; // PATCH (clear attribute)
});
jest.mock("@/lib/authentik", () => ({ authentikFetch: (p: string, o?: unknown) => mockAkFetch(p, o as { method?: string }) }));

let mockCfg: { users: Record<string, unknown>; groups: Record<string, unknown>; sha: string } = { users: {}, groups: {}, sha: "sha1" };
const mockSave = jest.fn(async () => {});
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: async () => mockCfg,
  saveUsersConfig: (...a: unknown[]) => mockSave(...a),
}));

const mockAudit = jest.fn(async () => {});
jest.mock("@/lib/audit-log", () => ({ auditLog: (...a: unknown[]) => mockAudit(...a) }));

import { bridgeEnrollmentGrants } from "@/lib/users/enrollment-grants";

beforeEach(() => {
  mockAkFetch.mockClear();
  mockSave.mockClear();
  mockAudit.mockClear();
  mockAkUsers = [];
  mockCfg = { users: {}, groups: {}, sha: "sha1" };
});

describe("bridgeEnrollmentGrants", () => {
  it("seeds users.yaml grants keyed by the enrolled username and clears the attribute", async () => {
    mockAkUsers = [
      { pk: 7, username: "friend", name: "A Friend", email: "friend@example.com", attributes: { iw_roles: [{ roleId: "jellyfin-user", scope: "/jellyfin" }, { roleId: "storage-contributor", scope: "/nas/x/media" }] } },
    ];
    const seeded = await bridgeEnrollmentGrants();
    expect(seeded).toEqual(["friend"]);
    expect(mockSave).toHaveBeenCalledTimes(1);
    const savedUsers = mockSave.mock.calls[0][0] as Record<string, { email?: string; role_assignments?: Array<{ roleId: string; scope: string; principalId: string }> }>;
    const grants = savedUsers.friend.role_assignments!;
    expect(grants.map((g) => `${g.roleId}@${g.scope}`).sort()).toEqual(["jellyfin-user@/jellyfin", "storage-contributor@/nas/x/media"]);
    expect(grants.every((g) => g.principalId === "friend")).toBe(true);
    expect(savedUsers.friend.email).toBe("friend@example.com");
    // attribute cleared via PATCH
    expect(mockAkFetch).toHaveBeenCalledWith("/core/users/7/", expect.objectContaining({ method: "PATCH" }));
  });

  it("does not duplicate a grant already present, and does not re-save when nothing is added", async () => {
    mockCfg = {
      users: { friend: { email: "friend@example.com", role_assignments: [{ id: "x", roleId: "jellyfin-user", scope: "/jellyfin", principalType: "user", principalId: "friend", grantedBy: "admin", grantedAt: "t" }] } },
      groups: {},
      sha: "sha1",
    };
    mockAkUsers = [{ pk: 7, username: "friend", attributes: { iw_roles: [{ roleId: "jellyfin-user", scope: "/jellyfin" }] } }];
    const seeded = await bridgeEnrollmentGrants();
    expect(seeded).toEqual(["friend"]);
    expect(mockSave).not.toHaveBeenCalled(); // grant already there → no write
    expect(mockAkFetch).toHaveBeenCalledWith("/core/users/7/", expect.objectContaining({ method: "PATCH" })); // still consume marker
  });

  it("ignores accounts with no iw_roles marker", async () => {
    mockAkUsers = [{ pk: 1, username: "remon", attributes: {} }, { pk: 2, username: "svc" }];
    const seeded = await bridgeEnrollmentGrants();
    expect(seeded).toEqual([]);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("does not clear the marker if the users.yaml write fails (retry next tick)", async () => {
    mockAkUsers = [{ pk: 7, username: "friend", attributes: { iw_roles: [{ roleId: "jellyfin-user", scope: "/jellyfin" }] } }];
    mockSave.mockRejectedValueOnce(new Error("git conflict"));
    const seeded = await bridgeEnrollmentGrants();
    expect(seeded).toEqual([]);
    const patchCalls = mockAkFetch.mock.calls.filter((c) => (c[1] as { method?: string })?.method === "PATCH");
    expect(patchCalls).toHaveLength(0);
  });
});
