// The reconcile module imports `server-only`; stub it for the CJS jest runtime.
jest.mock("server-only", () => ({}), { virtual: true });

const mockAuditLog = jest.fn(async () => {});
jest.mock("@/lib/audit-log", () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

let mockUsers: Record<string, unknown> = {};
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: async () => ({ users: mockUsers, groups: {}, sha: "sha", raw: "" }),
}));

const mockFindUser = jest.fn(async (_u: string): Promise<{ pk: number } | null> => null);
jest.mock("@/lib/authentik", () => ({ findUserByUsername: (u: string) => mockFindUser(u) }));

const mockCreateInvite = jest.fn(async () => ({ url: "https://auth.example/if/flow/x/?itoken=tok", token: "tok" }));
let mockHasLiveInvite = false;
jest.mock("@/lib/authentik-invite", () => ({
  createEnrollmentInvitation: (...a: unknown[]) => mockCreateInvite(...(a as [])),
  hasLiveInvitationForEmail: async () => mockHasLiveInvite,
}));

let mockMailerConfigured = true;
const mockSendInvite = jest.fn(async () => {});
jest.mock("@/lib/mailer", () => ({
  isMailerConfigured: () => mockMailerConfigured,
  sendInviteEmail: (...a: unknown[]) => mockSendInvite(...a),
}));

jest.mock("@/lib/nas/scope", () => ({ isNasScope: (s: string) => s.startsWith("/nas") }));
const mockSyncStorage = jest.fn(async () => ["group-rw"]);
jest.mock("@/lib/nas/access", () => ({ syncStorageScopesUnder: (s: string) => mockSyncStorage(s) }));

const mockReconcileJf = jest.fn(async () => {});
jest.mock("@/lib/jellyfin/access", () => ({
  isJellyfinScope: (s: string) => s === "/jellyfin" || s === "/" || s.startsWith("/jellyfin/"),
  JELLYFIN_SCOPE: "/jellyfin",
  reconcileJellyfinAccessWithRetry: (s: string) => mockReconcileJf(s),
}));

import { reconcileUsers, ensureEnrollmentInviteFor } from "@/lib/users/reconcile";

beforeEach(() => {
  mockAuditLog.mockClear();
  mockFindUser.mockClear();
  mockFindUser.mockResolvedValue(null);
  mockCreateInvite.mockClear();
  mockSendInvite.mockClear();
  mockSyncStorage.mockClear();
  mockReconcileJf.mockClear();
  mockMailerConfigured = true;
  mockHasLiveInvite = false;
  mockUsers = {};
});

describe("reconcileUsers", () => {
  it("auto-sends an enrollment invite for a user with no Authentik identity", async () => {
    mockUsers = { koen: { email: "koen@example.com", authentik_groups: ["nc-media-rw"] } };
    const s = await reconcileUsers();
    expect(mockCreateInvite).toHaveBeenCalledWith({ email: "koen@example.com", groups: ["nc-media-rw"], expiryHours: 168 });
    expect(mockSendInvite).toHaveBeenCalledWith("koen@example.com", expect.stringContaining("itoken=tok"));
    expect(s.invited).toEqual(["koen"]);
    expect(mockAuditLog).toHaveBeenCalledWith("users:auto-invite", "infraweaver", expect.any(String), expect.objectContaining({ result: "success" }));
  });

  it("does not invite an already-enrolled user", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    mockFindUser.mockResolvedValue({ pk: 21 });
    const s = await reconcileUsers();
    expect(mockSendInvite).not.toHaveBeenCalled();
    expect(s.enrolled).toEqual(["koen"]);
  });

  it("does not re-invite when a live invitation already exists", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    mockHasLiveInvite = true;
    const s = await reconcileUsers();
    expect(mockCreateInvite).not.toHaveBeenCalled();
    expect(s.pendingEnrollment).toEqual(["koen"]);
  });

  it("skips a user with no email", async () => {
    mockUsers = { noemail: { name: "No Email" } };
    const s = await reconcileUsers();
    expect(mockSendInvite).not.toHaveBeenCalled();
    expect(s.skippedNoEmail).toEqual(["noemail"]);
  });

  it("records an error (not an invite) when SMTP is unconfigured", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    mockMailerConfigured = false;
    const s = await reconcileUsers();
    expect(mockSendInvite).not.toHaveBeenCalled();
    expect(s.invited).toEqual([]);
    expect(s.errors[0].error).toMatch(/SMTP/);
  });

  it("converges storage + jellyfin reconciles for granted scopes", async () => {
    mockUsers = {
      koen: {
        email: "koen@example.com",
        role_assignments: [
          { roleId: "storage-contributor", scope: "/nas/truenas/infraweaver/media" },
          { roleId: "jellyfin-user", scope: "/jellyfin" },
        ],
      },
    };
    const s = await reconcileUsers();
    expect(mockSyncStorage).toHaveBeenCalledWith("/nas/truenas/infraweaver/media");
    expect(mockReconcileJf).toHaveBeenCalledWith("/jellyfin");
    expect(s.storageScopesReconciled).toEqual(["/nas/truenas/infraweaver/media"]);
    expect(s.jellyfinReconciled).toBe(true);
  });
});

describe("ensureEnrollmentInviteFor", () => {
  it("invites a granted user who has no identity yet", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    const sent = await ensureEnrollmentInviteFor("koen");
    expect(sent).toBe(true);
    expect(mockSendInvite).toHaveBeenCalled();
  });

  it("returns false for an already-enrolled user", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    mockFindUser.mockResolvedValue({ pk: 21 });
    const sent = await ensureEnrollmentInviteFor("koen");
    expect(sent).toBe(false);
    expect(mockSendInvite).not.toHaveBeenCalled();
  });

  it("never throws (swallows delivery failure)", async () => {
    mockUsers = { koen: { email: "koen@example.com" } };
    mockSendInvite.mockRejectedValueOnce(new Error("smtp down"));
    await expect(ensureEnrollmentInviteFor("koen")).resolves.toBe(false);
  });
});
