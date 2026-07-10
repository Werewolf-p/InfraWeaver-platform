/**
 * @jest-environment node
 */
// `reconcileJellyfinAccessWithRetry` is called fire-and-forget from a scope change,
// so nobody is awaiting it and no HTTP response carries its failure. When the retries
// are exhausted on a REVOKE, the disabled-in-intent user still holds a working
// Jellyfin login — a security-relevant fact that has to land somewhere reviewable.
// stderr is not that place; the audit log is.

jest.mock("server-only", () => ({}), { virtual: true });

const mockAuditLog = jest.fn();
const mockSyncAppUsers = jest.fn();

jest.mock("@/lib/audit-log", () => ({ auditLog: (...args: unknown[]) => mockAuditLog(...args) }));
jest.mock("@/lib/app-accounts/reconcile", () => ({ syncAppUsers: (...args: unknown[]) => mockSyncAppUsers(...args) }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: async () => ({ users: {}, groups: {}, sha: "", raw: "" }) }));
jest.mock("@/lib/app-accounts/policy", () => ({ computeDesiredAppUsers: () => ({ users: [], skippedNoEmail: [] }) }));
jest.mock("@/lib/app-accounts/store", () => ({ openBaoAppAccountStore: {} }));
jest.mock("@/lib/app-accounts/notify", () => ({ consoleAccountNotifier: {} }));
jest.mock("@/lib/jellyfin/provider", () => ({ JellyfinAccountProvider: class {} }));

import { reconcileJellyfinAccessWithRetry } from "@/lib/jellyfin/access";

/** Longer than the sum of the backoff delays (1s + 5s + 15s). */
const PAST_ALL_BACKOFF_MS = 30_000;

/** Drive the fire-and-forget reconcile to completion through its backoff sleeps. */
async function runToCompletion(scope: string): Promise<void> {
  const done = reconcileJellyfinAccessWithRetry(scope);
  await jest.advanceTimersByTimeAsync(PAST_ALL_BACKOFF_MS);
  await done;
}

describe("reconcileJellyfinAccessWithRetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockAuditLog.mockReset();
    mockSyncAppUsers.mockReset();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("raises a failure audit event when every retry is exhausted", async () => {
    mockSyncAppUsers.mockRejectedValue(new Error("jellyfin unreachable"));

    await runToCompletion("/jellyfin");

    expect(mockSyncAppUsers).toHaveBeenCalledTimes(4); // initial + 3 backoff retries
    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    const [action, actor, detail, options] = mockAuditLog.mock.calls[0];
    expect(action).toBe("jellyfin:access-sync");
    expect(actor).toBe("system");
    expect(detail).toContain("jellyfin unreachable");
    expect(detail).toMatch(/revoked user may retain a working local login/i);
    expect(options).toMatchObject({ result: "failure", resource: "/jellyfin" });
  });

  it("audits the scope that was actually reconciled, including the root scope", async () => {
    mockSyncAppUsers.mockRejectedValue(new Error("boom"));

    await runToCompletion("/");

    expect(mockAuditLog.mock.calls[0][3]).toMatchObject({ resource: "/" });
  });

  it("stays silent when the sync succeeds", async () => {
    mockSyncAppUsers.mockResolvedValue({ created: [], roleChanged: [], enabled: [], disabled: [], skippedNoEmail: [] });

    await runToCompletion("/jellyfin");

    expect(mockSyncAppUsers).toHaveBeenCalledTimes(1);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("stays silent when a transient failure is recovered by a retry", async () => {
    mockSyncAppUsers
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ created: [], roleChanged: [], enabled: [], disabled: [], skippedNoEmail: [] });

    await runToCompletion("/jellyfin");

    expect(mockSyncAppUsers).toHaveBeenCalledTimes(2);
    expect(mockAuditLog).not.toHaveBeenCalled();
  });

  it("does not touch Jellyfin, or audit, for a scope it does not govern", async () => {
    await runToCompletion("/wordpress/blog");

    expect(mockSyncAppUsers).not.toHaveBeenCalled();
    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});
