/**
 * @jest-environment node
 */
// resetNextcloudCredential is the admin recovery that mints a fresh LOCAL Nextcloud
// password (for native/WebDAV clients that cannot do SSO), sets it on the server over
// OCS, and persists it to OpenBao so it can later be revealed without another reset.
// It refuses the platform admin account and refuses a name Nextcloud does not have —
// it never fabricates an account, only (re)sets an existing one's local password.

jest.mock("server-only", () => ({}), { virtual: true });

const credentials = new Map<string, { password: string; email: string }>();
const setCalls: Array<{ userid: string; password: string }> = [];
let existingUsers = new Set<string>();

jest.mock("@/lib/app-accounts/store", () => ({
  openBaoAppAccountStore: {
    writeCredential: async (_app: string, username: string, password: string, email: string) => {
      credentials.set(username, { password, email });
    },
  },
}));

jest.mock("@/lib/nextcloud/client", () => ({
  nextcloudUserExists: async (userid: string) => existingUsers.has(userid.toLowerCase()),
  setNextcloudUserPassword: async (userid: string, password: string) => {
    setCalls.push({ userid, password });
  },
}));

jest.mock("@/lib/nextcloud/config", () => ({
  NEXTCLOUD_APP_ID: "nextcloud",
  nextcloudAdmin: () => ({ user: "admin", password: "x" }),
  nextcloudLaunchUrl: () => "https://nextcloud.int.example.com",
}));

jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: async () => ({ users: { koenluppers: { email: "koenluppers@gmail.com" } }, groups: {}, sha: "", raw: "" }),
}));

import {
  resetNextcloudCredential,
  UnmanagedNextcloudAccountError,
  ProtectedNextcloudAccountError,
} from "@/lib/nextcloud/access";

describe("resetNextcloudCredential", () => {
  beforeEach(() => {
    credentials.clear();
    setCalls.length = 0;
    existingUsers = new Set<string>();
  });

  it("refuses a name Nextcloud does not have", async () => {
    await expect(resetNextcloudCredential("stranger")).rejects.toBeInstanceOf(UnmanagedNextcloudAccountError);
    // Nothing was touched — no OCS password set, no credential write.
    expect(setCalls).toEqual([]);
    expect(credentials.size).toBe(0);
  });

  it("refuses the platform admin account, without even probing Nextcloud", async () => {
    existingUsers.add("admin");
    await expect(resetNextcloudCredential("admin")).rejects.toBeInstanceOf(ProtectedNextcloudAccountError);
    expect(setCalls).toEqual([]);
    expect(credentials.size).toBe(0);
  });

  it("resets an existing account: new password on the server, stored, and returned once", async () => {
    existingUsers.add("koenluppers");

    const result = await resetNextcloudCredential("koenluppers");

    // Reset sets a strong password on the server against the username...
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].userid).toBe("koenluppers");
    expect(setCalls[0].password).toHaveLength(20);
    // ...the same password is returned to the admin and persisted for reveal...
    expect(result.password).toBe(setCalls[0].password);
    expect(credentials.get("koenluppers")).toEqual({ password: result.password, email: "koenluppers@gmail.com" });
    // ...with the launch URL for hand-off.
    expect(result).toEqual({ username: "koenluppers", password: result.password, launchUrl: "https://nextcloud.int.example.com" });
  });

  it("matches the platform admin case-insensitively", async () => {
    await expect(resetNextcloudCredential("Admin")).rejects.toBeInstanceOf(ProtectedNextcloudAccountError);
  });
});
