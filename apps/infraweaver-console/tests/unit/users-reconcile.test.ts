// The reconcile module imports `server-only`; stub it for the CJS jest runtime.
jest.mock("server-only", () => ({}), { virtual: true });

const mockAuditLog = jest.fn(async () => {});
jest.mock("@/lib/audit-log", () => ({ auditLog: (...a: unknown[]) => mockAuditLog(...a) }));

let mockUsers: Record<string, unknown> = {};
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: async () => ({ users: mockUsers, groups: {}, sha: "sha", raw: "" }),
}));

const mockFindUser = jest.fn(async (_u: string): Promise<{ pk: number; username?: string } | null> => null);
const mockFindUserByEmail = jest.fn(async (_e: string): Promise<{ pk: number; username?: string } | null> => null);
jest.mock("@/lib/authentik", () => ({
  findUserByUsername: (u: string) => mockFindUser(u),
  findUserByEmail: (e: string) => mockFindUserByEmail(e),
}));

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
let mockGroupsByUser = new Map<string, string[]>();
jest.mock("@/lib/nas/access", () => ({
  syncStorageScopesUnder: (s: string) => mockSyncStorage(s),
  computeStorageGroupsByUser: async () => mockGroupsByUser,
}));

const mockReconcileJf = jest.fn(async () => {});
jest.mock("@/lib/jellyfin/access", () => ({
  isJellyfinScope: (s: string) => s === "/jellyfin" || s === "/" || s.startsWith("/jellyfin/"),
  JELLYFIN_SCOPE: "/jellyfin",
  reconcileJellyfinAccessWithRetry: (s: string) => mockReconcileJf(s),
}));

const mockBridge = jest.fn(async () => [] as string[]);
jest.mock("@/lib/users/enrollment-grants", () => ({ bridgeEnrollmentGrants: () => mockBridge() }));

let mockNcConfigured = false;
jest.mock("@/lib/nextcloud/config", () => ({ isNextcloudConfigured: () => mockNcConfigured }));
const mockEnsureNcProvision = jest.fn(
  async (input: { username: string; groups: string[] }) => ({ username: input.username, created: true, groups: input.groups }),
);
jest.mock("@/lib/nextcloud/provision", () => ({
  ensureNextcloudUserProvisioned: (...a: unknown[]) => mockEnsureNcProvision(...(a as [{ username: string; groups: string[] }])),
}));

import { reconcileUsers, ensureEnrollmentInviteFor } from "@/lib/users/reconcile";

beforeEach(() => {
  mockAuditLog.mockClear();
  mockFindUser.mockClear();
  mockFindUser.mockResolvedValue(null);
  mockFindUserByEmail.mockClear();
  mockFindUserByEmail.mockResolvedValue(null);
  mockCreateInvite.mockClear();
  mockSendInvite.mockClear();
  mockSyncStorage.mockClear();
  mockReconcileJf.mockClear();
  mockEnsureNcProvision.mockClear();
  mockEnsureNcProvision.mockImplementation(async (input) => ({ username: input.username, created: true, groups: input.groups }));
  mockBridge.mockClear();
  mockBridge.mockResolvedValue([]);
  mockMailerConfigured = true;
  mockHasLiveInvite = false;
  mockNcConfigured = false;
  mockGroupsByUser = new Map<string, string[]>();
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

  it("proactively provisions Nextcloud for an enrolled user with storage groups", async () => {
    mockNcConfigured = true;
    mockFindUser.mockResolvedValue({ pk: 21 }); // enrolled
    mockUsers = {
      koen: {
        email: "koen@example.com",
        name: "Koen",
        role_assignments: [{ roleId: "storage-contributor", scope: "/nas/truenas/infraweaver/media" }],
      },
    };
    mockGroupsByUser = new Map([["koen", ["storage-truenas-infraweaver-media-abc-ro", "storage-truenas-infraweaver-media-abc-rw"]]]);
    const s = await reconcileUsers();
    expect(mockEnsureNcProvision).toHaveBeenCalledWith({
      username: "koen",
      email: "koen@example.com",
      displayName: "Koen",
      groups: ["storage-truenas-infraweaver-media-abc-ro", "storage-truenas-infraweaver-media-abc-rw"],
    });
    expect(s.nextcloudProvisioned).toEqual(["koen"]);
    expect(mockAuditLog).toHaveBeenCalledWith("users:nextcloud-provision", "infraweaver", expect.any(String), expect.objectContaining({ result: "success" }));
  });

  it("does not report an already-existing Nextcloud account as newly provisioned", async () => {
    mockNcConfigured = true;
    mockFindUser.mockResolvedValue({ pk: 21 });
    mockEnsureNcProvision.mockImplementation(async (input) => ({ username: input.username, created: false, groups: input.groups }));
    mockUsers = { koen: { email: "koen@example.com", role_assignments: [{ roleId: "storage-contributor", scope: "/nas/truenas/infraweaver/media" }] } };
    mockGroupsByUser = new Map([["koen", ["storage-truenas-infraweaver-media-abc-rw"]]]);
    const s = await reconcileUsers();
    expect(mockEnsureNcProvision).toHaveBeenCalled();
    expect(s.nextcloudProvisioned).toEqual([]);
  });

  it("skips Nextcloud provisioning for an enrolled user with no storage groups", async () => {
    mockNcConfigured = true;
    mockFindUser.mockResolvedValue({ pk: 21 });
    mockUsers = { koen: { email: "koen@example.com", role_assignments: [{ roleId: "jellyfin-user", scope: "/jellyfin" }] } };
    // computeStorageGroupsByUser returns empty → but storage sync must have run for the
    // block to be reached; a jellyfin-only user yields no storage scopes, so it's skipped.
    const s = await reconcileUsers();
    expect(mockEnsureNcProvision).not.toHaveBeenCalled();
    expect(s.nextcloudProvisioned).toEqual([]);
  });

  it("resolves the Authentik username by email and provisions NC under it when the users.yaml key drifted", async () => {
    mockNcConfigured = true;
    mockFindUser.mockResolvedValue(null); // 'koen' is not an Authentik username
    mockFindUserByEmail.mockResolvedValue({ pk: 30, username: "koenluppers" }); // but the email matches
    mockUsers = { koen: { email: "koen@example.com", role_assignments: [{ roleId: "storage-contributor", scope: "/nas/truenas/infraweaver/media" }] } };
    mockGroupsByUser = new Map([["koen", ["storage-x-rw"]]]); // groups keyed by the users.yaml key
    const s = await reconcileUsers();
    expect(s.enrolled).toContain("koenluppers"); // canonical AK username, not the drifted key
    expect(mockEnsureNcProvision).toHaveBeenCalledWith(expect.objectContaining({ username: "koenluppers", groups: ["storage-x-rw"] }));
  });

  it("runs the enrollment-grant bridge and surfaces what it seeded", async () => {
    mockBridge.mockResolvedValue(["newbie"]);
    mockUsers = {};
    const s = await reconcileUsers();
    expect(mockBridge).toHaveBeenCalled();
    expect(s.enrollmentGrantsSeeded).toEqual(["newbie"]);
  });

  it("does not provision Nextcloud when NC is not configured", async () => {
    mockNcConfigured = false;
    mockFindUser.mockResolvedValue({ pk: 21 });
    mockUsers = { koen: { email: "koen@example.com", role_assignments: [{ roleId: "storage-contributor", scope: "/nas/truenas/infraweaver/media" }] } };
    mockGroupsByUser = new Map([["koen", ["storage-truenas-infraweaver-media-abc-rw"]]]);
    const s = await reconcileUsers();
    expect(mockEnsureNcProvision).not.toHaveBeenCalled();
    expect(s.nextcloudProvisioned).toEqual([]);
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
