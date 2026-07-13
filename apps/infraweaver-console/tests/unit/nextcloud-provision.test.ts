jest.mock("server-only", () => ({}), { virtual: true });

const mockExists = jest.fn(async (_u: string) => false);
const mockCreate = jest.fn(async (_i: unknown) => ({ created: true }));
const mockEnsureGroup = jest.fn(async (_g: string) => {});
const mockAddToGroup = jest.fn(async (_u: string, _g: string) => {});
jest.mock("@/lib/nextcloud/client", () => ({
  nextcloudUserExists: (u: string) => mockExists(u),
  createNextcloudUser: (i: unknown) => mockCreate(i),
  ensureNextcloudGroup: (g: string) => mockEnsureGroup(g),
  addNextcloudUserToGroup: (u: string, g: string) => mockAddToGroup(u, g),
}));

const mockWriteCredential = jest.fn(async () => {});
jest.mock("@/lib/app-accounts/store", () => ({
  openBaoAppAccountStore: { writeCredential: (...a: unknown[]) => mockWriteCredential(...a) },
}));

jest.mock("@/lib/app-accounts/password", () => ({ generateAppPassword: () => "generated-pw" }));
jest.mock("@/lib/nextcloud/config", () => ({ NEXTCLOUD_APP_ID: "nextcloud" }));

import { ensureNextcloudUserProvisioned } from "@/lib/nextcloud/provision";

beforeEach(() => {
  mockExists.mockReset().mockResolvedValue(false);
  mockCreate.mockReset().mockResolvedValue({ created: true });
  mockEnsureGroup.mockReset().mockResolvedValue(undefined);
  mockAddToGroup.mockReset().mockResolvedValue(undefined);
  mockWriteCredential.mockReset().mockResolvedValue(undefined);
});

describe("ensureNextcloudUserProvisioned", () => {
  it("creates an absent account, stores its credential, and joins its groups", async () => {
    const r = await ensureNextcloudUserProvisioned({
      username: "koen",
      email: "koen@example.com",
      displayName: "Koen",
      groups: ["storage-x-ro", "storage-x-rw"],
    });
    expect(mockCreate).toHaveBeenCalledWith({ userid: "koen", password: "generated-pw", email: "koen@example.com", displayName: "Koen" });
    expect(mockWriteCredential).toHaveBeenCalledWith("nextcloud", "koen", "generated-pw", "koen@example.com");
    expect(mockEnsureGroup).toHaveBeenCalledTimes(2);
    expect(mockAddToGroup).toHaveBeenCalledWith("koen", "storage-x-ro");
    expect(mockAddToGroup).toHaveBeenCalledWith("koen", "storage-x-rw");
    expect(r).toEqual({ username: "koen", created: true, groups: ["storage-x-ro", "storage-x-rw"] });
  });

  it("leaves an existing account intact (no create, no password reset) and only re-ensures groups", async () => {
    mockExists.mockResolvedValue(true);
    const r = await ensureNextcloudUserProvisioned({ username: "koen", email: "koen@example.com", groups: ["storage-x-rw"] });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockWriteCredential).not.toHaveBeenCalled();
    expect(mockAddToGroup).toHaveBeenCalledWith("koen", "storage-x-rw");
    expect(r.created).toBe(false);
  });

  it("treats an OCS 'already exists' create as not-created and does not store a credential", async () => {
    mockCreate.mockResolvedValue({ created: false });
    const r = await ensureNextcloudUserProvisioned({ username: "koen", email: "koen@example.com", groups: [] });
    expect(mockWriteCredential).not.toHaveBeenCalled();
    expect(r.created).toBe(false);
  });

  it("keeps provisioning other groups when one group binding fails", async () => {
    mockAddToGroup.mockImplementation(async (_u: string, g: string) => {
      if (g === "bad") throw new Error("group bind failed");
    });
    const r = await ensureNextcloudUserProvisioned({ username: "koen", email: "koen@example.com", groups: ["bad", "good"] });
    expect(r.groups).toEqual(["good"]);
  });
});
