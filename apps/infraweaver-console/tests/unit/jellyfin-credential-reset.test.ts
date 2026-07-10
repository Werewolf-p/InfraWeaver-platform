/**
 * @jest-environment node
 */
// resetJellyfinCredential is the explicit, audited admin action that makes an ADOPTED
// Jellyfin account (whose original password was lost in the orphan window) usable
// again. It resets only accounts InfraWeaver manages (on the roster), mints a new
// password, sets it on the server, and records the hand-off so the account stops
// surfacing as adopted/pending.

jest.mock("server-only", () => ({}), { virtual: true });

const roster: Array<{ username: string; providerUserId: string; provisionedAt: string; adoptedAt?: string; notifiedAt?: string }> = [];
const credentials = new Map<string, { password: string; email: string }>();
const notified: string[] = [];
const resetCalls: Array<{ id: string; password: string }> = [];
let ensureCalls = 0;

jest.mock("@/lib/app-accounts/store", () => ({
  openBaoAppAccountStore: {
    loadRoster: async () => [...roster],
    writeCredential: async (_app: string, username: string, password: string, email: string) => {
      credentials.set(username, { password, email });
    },
    markNotified: async (_app: string, username: string) => {
      notified.push(username);
    },
  },
}));

jest.mock("@/lib/jellyfin/provider", () => ({
  JellyfinAccountProvider: class {
    async ensureServiceAccount() {
      ensureCalls++;
    }
    async resetPassword(id: string, password: string) {
      resetCalls.push({ id, password });
    }
  },
}));

jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: async () => ({ users: { carol: { email: "carol@x.com" } }, groups: {}, sha: "", raw: "" }),
}));

import { resetJellyfinCredential, UnmanagedJellyfinAccountError } from "@/lib/jellyfin/access";

describe("resetJellyfinCredential", () => {
  beforeEach(() => {
    roster.length = 0;
    credentials.clear();
    notified.length = 0;
    resetCalls.length = 0;
    ensureCalls = 0;
  });

  it("refuses a name that is not an InfraWeaver-managed account", async () => {
    roster.push({ username: "carol", providerUserId: "u-carol", provisionedAt: "t" });

    await expect(resetJellyfinCredential("stranger")).rejects.toBeInstanceOf(UnmanagedJellyfinAccountError);
    // Nothing was touched — no Jellyfin call, no credential write.
    expect(resetCalls).toEqual([]);
    expect(credentials.size).toBe(0);
  });

  it("resets a managed (adopted) account: new password on the server, stored, and handed off", async () => {
    roster.push({ username: "carol", providerUserId: "u-carol", provisionedAt: "t", adoptedAt: "t" });

    const result = await resetJellyfinCredential("carol");

    expect(ensureCalls).toBe(1);
    // Reset hits the server against the roster's provider id, with a strong password...
    expect(resetCalls).toHaveLength(1);
    expect(resetCalls[0].id).toBe("u-carol");
    expect(resetCalls[0].password).toHaveLength(20);
    // ...the same password is returned to the admin and persisted for reveal...
    expect(result.password).toBe(resetCalls[0].password);
    expect(credentials.get("carol")).toEqual({ password: result.password, email: "carol@x.com" });
    // ...and the hand-off is recorded, which clears the adopted/pending report.
    expect(notified).toEqual(["carol"]);
    expect(result.username).toBe("carol");
  });

  it("matches the roster case-insensitively", async () => {
    roster.push({ username: "Carol", providerUserId: "u-carol", provisionedAt: "t" });

    const result = await resetJellyfinCredential("carol");
    expect(result.username).toBe("Carol");
    expect(resetCalls[0].id).toBe("u-carol");
  });
});
