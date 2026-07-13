// The notifier imports `server-only`; stub it so the CJS jest runtime can load it.
jest.mock("server-only", () => ({}), { virtual: true });

const mockAuditLog = jest.fn(async () => {});
jest.mock("@/lib/audit-log", () => ({ auditLog: (...args: unknown[]) => mockAuditLog(...args) }));

let mockMailerConfigured = true;
const mockSendCredentialEmail = jest.fn(async () => {});
jest.mock("@/lib/mailer", () => ({
  isMailerConfigured: () => mockMailerConfigured,
  sendCredentialEmail: (...args: unknown[]) => mockSendCredentialEmail(...args),
}));

import { consoleAccountNotifier } from "@/lib/app-accounts/notify";
import type { ProvisionedCredential } from "@/lib/app-accounts/types";

const credential: ProvisionedCredential = {
  appId: "jellyfin",
  appLabel: "Jellyfin",
  launchUrl: "https://jellyfin.int.example.com",
  username: "koenluppers",
  email: "koen@example.com",
  password: "ExamplePasswordX9",
};

beforeEach(() => {
  mockAuditLog.mockClear();
  mockSendCredentialEmail.mockClear();
  mockSendCredentialEmail.mockResolvedValue(undefined);
  mockMailerConfigured = true;
});

describe("consoleAccountNotifier.notifyProvisioned", () => {
  it("emails the credentials when SMTP is configured", async () => {
    await consoleAccountNotifier.notifyProvisioned(credential);

    expect(mockSendCredentialEmail).toHaveBeenCalledWith({
      to: "koen@example.com",
      appLabel: "Jellyfin",
      launchUrl: "https://jellyfin.int.example.com",
      username: "koenluppers",
      password: "ExamplePasswordX9",
    });
    expect(mockAuditLog).toHaveBeenCalledWith(
      "app-account:provisioned",
      "infraweaver",
      expect.stringContaining("credentials emailed"),
      { resource: "jellyfin/koenluppers" },
    );
  });

  it("never puts the plaintext password into the audit line", async () => {
    await consoleAccountNotifier.notifyProvisioned(credential);
    for (const call of mockAuditLog.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("ExamplePasswordX9");
    }
  });

  it("falls back to pull-based hand-off (no email) when SMTP is not configured", async () => {
    mockMailerConfigured = false;

    await consoleAccountNotifier.notifyProvisioned(credential);

    expect(mockSendCredentialEmail).not.toHaveBeenCalled();
    expect(mockAuditLog).toHaveBeenCalledWith(
      "app-account:provisioned",
      "infraweaver",
      expect.stringContaining("stored for hand-off"),
      { resource: "jellyfin/koenluppers" },
    );
  });

  it("rethrows and audits a failure when the email send fails (→ pendingHandoff)", async () => {
    const boom = new Error("SMTP 550 rejected");
    mockSendCredentialEmail.mockRejectedValueOnce(boom);

    await expect(consoleAccountNotifier.notifyProvisioned(credential)).rejects.toThrow("SMTP 550 rejected");

    expect(mockAuditLog).toHaveBeenCalledWith(
      "app-account:handoff-failed",
      "infraweaver",
      expect.stringContaining("Failed to email"),
      { resource: "jellyfin/koenluppers" },
    );
    // The success line must NOT have been written on a failed send.
    expect(mockAuditLog).not.toHaveBeenCalledWith(
      "app-account:provisioned",
      "infraweaver",
      expect.stringContaining("emailed"),
      expect.anything(),
    );
  });
});
