/**
 * @jest-environment node
 */
// Unit coverage for `resetJellyfinCredential` — the audited admin action that makes
// an ADOPTED Jellyfin account usable again (its original password was lost in the
// orphan window) and the general password-reset recovery.
//
// The invariants pinned here:
//   - it resets ONLY a roster-managed account (case-insensitively), refusing an
//     unmanaged name with a distinct error the route turns into a 404;
//   - it mints the password, sets it on the server, persists it for reveal, and
//     records the hand-off (markNotified) so the account stops surfacing as adopted;
//   - a managed account with no email on record still resets (blank email), it is
//     not silently skipped.
// The full HTTP-level adopt->reset path is exercised by
// tests/e2e/jellyfin-adopt-reset.spec.ts against in-process fakes.

jest.mock("server-only", () => ({}), { virtual: true });

const mockLoadRoster = jest.fn();
const mockWriteCredential = jest.fn();
const mockMarkNotified = jest.fn();
const mockEnsureService = jest.fn();
const mockResetPassword = jest.fn();
const mockLoadUsersConfig = jest.fn();

jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: (...args: unknown[]) => mockLoadUsersConfig(...args) }));
jest.mock("@/lib/app-accounts/store", () => ({
  openBaoAppAccountStore: {
    loadRoster: (...args: unknown[]) => mockLoadRoster(...args),
    writeCredential: (...args: unknown[]) => mockWriteCredential(...args),
    markNotified: (...args: unknown[]) => mockMarkNotified(...args),
  },
}));
jest.mock("@/lib/jellyfin/provider", () => ({
  JellyfinAccountProvider: class {
    ensureServiceAccount = mockEnsureService;
    resetPassword = mockResetPassword;
  },
}));

import { resetJellyfinCredential, UnmanagedJellyfinAccountError } from "@/lib/jellyfin/access";
import { JELLYFIN_APP_ID } from "@/lib/jellyfin/config";

const ADOPTED_ALICE = {
  username: "alice",
  providerUserId: "guid-alice",
  provisionedAt: "2026-01-01T00:00:00.000Z",
  adoptedAt: "2026-01-02T00:00:00.000Z",
};

describe("resetJellyfinCredential", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadRoster.mockResolvedValue([ADOPTED_ALICE]);
    mockLoadUsersConfig.mockResolvedValue({ users: { alice: { email: "alice@example.com" } }, groups: {}, sha: "", raw: "" });
  });

  it("mints a new password, sets it on the server, stores it, and records the hand-off", async () => {
    const result = await resetJellyfinCredential("alice");

    expect(mockEnsureService).toHaveBeenCalledTimes(1);
    // Reset targets the account's provider-native id, not its username.
    expect(mockResetPassword).toHaveBeenCalledTimes(1);
    const [providerUserId, password] = mockResetPassword.mock.calls[0];
    expect(providerUserId).toBe("guid-alice");
    expect(typeof password).toBe("string");
    expect(password.length).toBeGreaterThanOrEqual(16);

    // The same freshly-minted password is what is returned, persisted, and revealable.
    expect(result).toEqual({ username: "alice", password, launchUrl: expect.any(String) });
    expect(mockWriteCredential).toHaveBeenCalledWith(JELLYFIN_APP_ID, "alice", password, "alice@example.com");
    expect(mockMarkNotified).toHaveBeenCalledWith(JELLYFIN_APP_ID, "alice", expect.any(String));
  });

  it("matches the roster case-insensitively and returns the stored username", async () => {
    const result = await resetJellyfinCredential("ALICE");

    expect(result.username).toBe("alice");
    expect(mockResetPassword).toHaveBeenCalledTimes(1);
  });

  it("refuses a name that is not on the roster, without touching the server", async () => {
    mockLoadRoster.mockResolvedValue([ADOPTED_ALICE]);

    await expect(resetJellyfinCredential("mallory")).rejects.toBeInstanceOf(UnmanagedJellyfinAccountError);
    expect(mockEnsureService).not.toHaveBeenCalled();
    expect(mockResetPassword).not.toHaveBeenCalled();
    expect(mockWriteCredential).not.toHaveBeenCalled();
  });

  it("still resets a managed account that has no email on record (blank, not skipped)", async () => {
    mockLoadUsersConfig.mockResolvedValue({ users: {}, groups: {}, sha: "", raw: "" });

    const result = await resetJellyfinCredential("alice");

    expect(result.username).toBe("alice");
    expect(mockWriteCredential).toHaveBeenCalledWith(JELLYFIN_APP_ID, "alice", expect.any(String), "");
  });
});
