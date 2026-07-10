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
  async notifyProvisioned(credential: ProvisionedCredential): Promise<void> {
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
