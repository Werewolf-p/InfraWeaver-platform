// The engine imports `server-only`; stub it so the CJS jest runtime can load it.
jest.mock("server-only", () => ({}), { virtual: true });

import { syncAppUsers } from "@/lib/app-accounts/reconcile";
import type {
  AccountNotifier,
  AppAccountProvider,
  AppAccountStore,
  AppUserAccount,
  AppUserRole,
  DesiredAppUsers,
  ProvisionedCredential,
  RosterEntry,
} from "@/lib/app-accounts/types";

/** An in-memory Jellyfin-shaped app: full account CRUD, no HTTP. */
class FakeProvider implements AppAccountProvider {
  appId = "fake";
  appLabel = "Fake";
  launchUrl = "https://fake.example.com";
  serviceAccountUsername = "iw-service";
  ensureCalls = 0;
  private seq = 0;
  users = new Map<string, AppUserAccount>();

  constructor() {
    // Keyed by id (like created users) so lookups by id are consistent.
    this.users.set("svc", { id: "svc", username: "iw-service", role: "admin", disabled: false });
  }
  async ensureServiceAccount(): Promise<void> {
    this.ensureCalls++;
  }
  async listUsers(): Promise<AppUserAccount[]> {
    return [...this.users.values()];
  }
  async createUser(username: string, _password: string): Promise<AppUserAccount> {
    const account: AppUserAccount = { id: `u${++this.seq}`, username, role: "user", disabled: false };
    this.users.set(account.id, account);
    return account;
  }
  async setUserRole(id: string, role: AppUserRole): Promise<void> {
    const account = this.users.get(id);
    if (account) this.users.set(id, { ...account, role });
  }
  async disableUser(id: string): Promise<void> {
    const account = this.users.get(id);
    if (account) this.users.set(id, { ...account, disabled: true });
  }
  async enableUser(id: string): Promise<void> {
    const account = this.users.get(id);
    if (account) this.users.set(id, { ...account, disabled: false });
  }
  passwordResets: string[] = [];
  async resetPassword(id: string, _password: string): Promise<void> {
    this.passwordResets.push(id);
  }

  /** Seed an account that exists in the app but was never rostered — the orphan a
   *  half-finished provision leaves behind (createUser landed, addRosterEntry did not). */
  seedOrphan(username: string, role: AppUserRole = "user"): AppUserAccount {
    const account: AppUserAccount = { id: `orphan-${username}`, username, role, disabled: false };
    this.users.set(account.id, account);
    return account;
  }
}

/** In-memory roster + credential store. */
class FakeStore implements AppAccountStore {
  roster: RosterEntry[] = [];
  credentials = new Map<string, { password: string; email: string }>();
  async loadRoster(): Promise<RosterEntry[]> {
    return [...this.roster];
  }
  async addRosterEntry(_appId: string, entry: RosterEntry): Promise<void> {
    this.roster.push(entry);
  }
  async markNotified(_appId: string, username: string, notifiedAt: string): Promise<void> {
    this.roster = this.roster.map((e) => (e.username === username ? { ...e, notifiedAt } : e));
  }
  async removeRosterEntry(_appId: string, username: string): Promise<void> {
    this.roster = this.roster.filter((e) => e.username !== username);
  }
  async writeCredential(_appId: string, username: string, password: string, email: string): Promise<void> {
    this.credentials.set(username, { password, email });
  }
  async deleteCredential(_appId: string, username: string): Promise<void> {
    this.credentials.delete(username);
  }
}

class RecordingNotifier implements AccountNotifier {
  sent: ProvisionedCredential[] = [];
  /** Set to fail the next delivery only, mimicking a transient notifier fault. */
  failNext = false;
  async notifyProvisioned(credential: ProvisionedCredential): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("notifier unavailable");
    }
    this.sent.push(credential);
  }
}

function desired(...users: { username: string; role?: AppUserRole }[]): DesiredAppUsers {
  return {
    users: users.map((u) => ({ username: u.username, email: `${u.username}@x.com`, role: u.role ?? "user" })),
    skippedNoEmail: [],
  };
}

describe("syncAppUsers", () => {
  beforeEach(() => {
    // A failed hand-off notification logs; keep the expected noise out of the report.
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a newly-authorized user, stores a strong credential, and notifies exactly once", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    const summary = await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });

    expect(summary.created).toEqual(["alice"]);
    expect(provider.ensureServiceAccount).toBeDefined();
    expect(provider.ensureCalls).toBe(1);
    // Account materialized in the app...
    expect([...provider.users.values()].some((u) => u.username === "alice")).toBe(true);
    // ...credential persisted for out-of-band reveal, and it is strong...
    expect(store.credentials.get("alice")?.password).toHaveLength(20);
    // ...and delivered exactly once, carrying the app URL.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({ username: "alice", email: "alice@x.com", launchUrl: provider.launchUrl });
    // Roster records the provisioning + the notification.
    expect(store.roster).toHaveLength(1);
    expect(store.roster[0].notifiedAt).toBeTruthy();
  });

  it("is idempotent: a second run with unchanged grants creates nothing and re-emails nobody", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const before = notifier.sent.length;
    const summary = await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });

    expect(summary.created).toEqual([]);
    expect(notifier.sent).toHaveLength(before); // no re-email
  });

  it("disables a managed account when its grant is revoked, without touching the credential’s owner elsewhere", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const summary = await syncAppUsers(provider, desired(), { store, notifier }); // alice revoked

    expect(summary.disabled).toEqual(["alice"]);
    const alice = [...provider.users.values()].find((u) => u.username === "alice");
    expect(alice?.disabled).toBe(true);
  });

  it("re-enables the same account on a re-grant, with no new password and no new email", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const originalPassword = store.credentials.get("alice")?.password;
    await syncAppUsers(provider, desired(), { store, notifier }); // revoke
    const summary = await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier }); // re-grant

    expect(summary.enabled).toEqual(["alice"]);
    expect(summary.created).toEqual([]);
    expect(store.credentials.get("alice")?.password).toBe(originalPassword); // unchanged
    expect(notifier.sent).toHaveLength(1); // still only the original notification
  });

  it("converges an existing account's role when the grant is upgraded to admin", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired({ username: "alice", role: "user" }), { store, notifier });
    const summary = await syncAppUsers(provider, desired({ username: "alice", role: "admin" }), { store, notifier });

    expect(summary.roleChanged).toEqual(["alice"]);
    const alice = [...provider.users.values()].find((u) => u.username === "alice");
    expect(alice?.role).toBe("admin");
  });

  it("never disables the service account even though it is not in the desired set", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired(), { store, notifier });

    const svc = provider.users.get("svc");
    expect(svc?.disabled).toBe(false);
  });

  it("leaves a created account revocable and recoverable when setUserRole fails mid-provision", async () => {
    // The dangerous window: `createUser` has already minted a live account. If the
    // roster write came after `setUserRole`, this failure would strand an account
    // the plan can never disable and whose one-time password nobody can read back.
    class RoleFailsOnce extends FakeProvider {
      private failNext = true;
      async setUserRole(id: string, role: AppUserRole): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("jellyfin 500");
        }
        await super.setUserRole(id, role);
      }
    }
    const provider = new RoleFailsOnce();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await expect(
      syncAppUsers(provider, desired({ username: "alice", role: "admin" }), { store, notifier }),
    ).rejects.toThrow("jellyfin 500");

    // The account exists in the app, so it must already be both revocable...
    expect([...provider.users.values()].some((u) => u.username === "alice")).toBe(true);
    expect(store.roster.map((e) => e.username)).toEqual(["alice"]);
    // ...and recoverable: a re-run never re-creates, so this password is the only one.
    expect(store.credentials.get("alice")?.password).toHaveLength(20);

    // Proof of the property that matters: the revoke now actually lands.
    const summary = await syncAppUsers(provider, desired(), { store, notifier });
    expect(summary.disabled).toEqual(["alice"]);
    expect([...provider.users.values()].find((u) => u.username === "alice")?.disabled).toBe(true);
  });

  it("re-roles an account whose setUserRole failed during provisioning on the next pass", async () => {
    class RoleFailsOnce extends FakeProvider {
      private failNext = true;
      async setUserRole(id: string, role: AppUserRole): Promise<void> {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("jellyfin 500");
        }
        await super.setUserRole(id, role);
      }
    }
    const provider = new RoleFailsOnce();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await expect(
      syncAppUsers(provider, desired({ username: "alice", role: "admin" }), { store, notifier }),
    ).rejects.toThrow("jellyfin 500");

    const summary = await syncAppUsers(provider, desired({ username: "alice", role: "admin" }), { store, notifier });

    expect(summary.created).toEqual([]); // never re-created, so never re-passworded
    expect(summary.roleChanged).toEqual(["alice"]);
    expect([...provider.users.values()].find((u) => u.username === "alice")?.role).toBe("admin");
  });

  it("reports a created account whose hand-off notification failed, without losing the account", async () => {
    // The notify is the LAST step and delivery is pull-based (the grantee reveals
    // the password in-console), so a notifier failure must not undo, abort, or hide
    // a perfectly good account. It must, however, be visible.
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    notifier.failNext = true;

    const summary = await syncAppUsers(provider, desired({ username: "alice" }, { username: "bob" }), { store, notifier });

    expect(summary.created).toEqual(["alice", "bob"]); // bob is NOT stranded behind alice's failure
    expect(summary.pendingHandoff).toEqual(["alice"]);
    expect(store.credentials.get("alice")?.password).toHaveLength(20); // still revealable
    expect(store.roster.find((e) => e.username === "alice")?.notifiedAt).toBeUndefined();
    expect(store.roster.find((e) => e.username === "bob")?.notifiedAt).toBeTruthy();
  });

  it("keeps reporting an un-notified account on later passes, when the retry loop would otherwise hide it", async () => {
    // The bug this pins: once `alice` exists, `buildAppUserSyncPlan` never re-creates
    // her, so `provisionAccount` — and with it the notify — never runs again. A caller
    // that retries the whole sync (`reconcileJellyfinAccessWithRetry`) therefore sees
    // attempt 2 SUCCEED, and alice's missing hand-off vanishes from every signal.
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    notifier.failNext = true;

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const second = await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });

    expect(second.created).toEqual([]); // nothing to do — and that is exactly the trap
    expect(notifier.sent).toHaveLength(0); // the notify genuinely never re-runs
    expect(second.pendingHandoff).toEqual(["alice"]); // ...but the roster still says so
  });

  it("stops reporting a pending hand-off once the grant is revoked", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    notifier.failNext = true;

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const revoked = await syncAppUsers(provider, desired(), { store, notifier });

    // No hand-off is owed to someone whose access was taken away.
    expect(revoked.disabled).toEqual(["alice"]);
    expect(revoked.pendingHandoff).toEqual([]);
  });

  it("reports no pending hand-off when every managed account was notified", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });
    const second = await syncAppUsers(provider, desired({ username: "alice" }), { store, notifier });

    expect(second.pendingHandoff).toEqual([]);
  });

  it("adopts an orphan that exists under a desired username but is missing from the roster, and makes it revocable", async () => {
    // The residual orphan window from #152: `createUser` landed, `addRosterEntry` did
    // not. The account is live but unmanaged, so no later sync could ever disable it.
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    provider.seedOrphan("carol");

    const summary = await syncAppUsers(provider, desired({ username: "carol" }), { store, notifier });

    expect(summary.adopted).toEqual(["carol"]);
    expect(summary.created).toEqual([]); // it already exists — never re-created
    // Rostered (revocable again) and flagged as adopted...
    const entry = store.roster.find((e) => e.username === "carol");
    expect(entry?.adoptedAt).toBeTruthy();
    expect(entry?.providerUserId).toBe("orphan-carol");
    // ...but the credential is NOT silently reset: nothing written, nobody notified.
    expect(store.credentials.has("carol")).toBe(false);
    expect(notifier.sent).toHaveLength(0);
    expect(provider.passwordResets).toEqual([]);

    // The property that matters: the revoke now actually lands.
    const revoked = await syncAppUsers(provider, desired(), { store, notifier });
    expect(revoked.disabled).toEqual(["carol"]);
    expect([...provider.users.values()].find((u) => u.username === "carol")?.disabled).toBe(true);
  });

  it("never adopts an unrostered account that RBAC does not authorize (a manual/app-native one)", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    provider.seedOrphan("dave"); // exists in the app, but nobody granted 'dave'

    const summary = await syncAppUsers(provider, desired(), { store, notifier });

    expect(summary.adopted).toEqual([]);
    expect(store.roster).toHaveLength(0);
    // And, being unmanaged, it is never disabled.
    expect([...provider.users.values()].find((u) => u.username === "dave")?.disabled).toBe(false);
  });

  it("never adopts the service account even if it appears in the desired set", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    // The service account already exists (seeded in the ctor) and is protected.
    const summary = await syncAppUsers(provider, desired({ username: "iw-service" }), { store, notifier });

    expect(summary.adopted).toEqual([]);
    expect(store.roster).toHaveLength(0);
  });

  it("keeps reporting an adopted account until its credential is explicitly reset, and never as a pending hand-off", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    provider.seedOrphan("carol");

    const first = await syncAppUsers(provider, desired({ username: "carol" }), { store, notifier });
    expect(first.adopted).toEqual(["carol"]);
    // An adopted account has no revealable password, so it must NOT masquerade as a
    // pending hand-off (which tells the panel "reveal it", and would 404).
    expect(first.pendingHandoff).toEqual([]);

    const second = await syncAppUsers(provider, desired({ username: "carol" }), { store, notifier });
    expect(second.adopted).toEqual(["carol"]); // still, until a reset lands
    expect(second.created).toEqual([]);
    expect(second.pendingHandoff).toEqual([]);

    // Simulate the explicit admin reset: a credential is written and the hand-off
    // recorded (what resetJellyfinCredential does).
    await store.writeCredential("fake", "carol", "pw", "carol@x.com");
    await store.markNotified("fake", "carol", new Date().toISOString());

    const third = await syncAppUsers(provider, desired({ username: "carol" }), { store, notifier });
    expect(third.adopted).toEqual([]); // reset clears it
    expect(third.pendingHandoff).toEqual([]);
  });

  it("stops reporting an adopted account once its grant is revoked", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();
    provider.seedOrphan("carol");

    await syncAppUsers(provider, desired({ username: "carol" }), { store, notifier });
    const revoked = await syncAppUsers(provider, desired(), { store, notifier });

    expect(revoked.disabled).toEqual(["carol"]);
    expect(revoked.adopted).toEqual([]); // no hand-off owed to a revoked user
  });

  it("surfaces users skipped for a missing email", async () => {
    const provider = new FakeProvider();
    const store = new FakeStore();
    const notifier = new RecordingNotifier();

    const summary = await syncAppUsers(
      provider,
      { users: [], skippedNoEmail: ["no-email-user"] },
      { store, notifier },
    );
    expect(summary.skippedNoEmail).toEqual(["no-email-user"]);
  });
});
