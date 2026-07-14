/**
 * @jest-environment node
 *
 * syncJellyfinUsers must create a Jellyfin account ONLY after the person enrolls in
 * Authentik, keyed by the canonical Authentik username (never a drifted users.yaml
 * key) — so the Jellyfin login matches the SSO login. An already-provisioned account
 * is kept even if the Authentik lookup transiently misses, so an Authentik blip can
 * never false-revoke a working login.
 */
jest.mock("server-only", () => ({}), { virtual: true });

const mockSyncAppUsers = jest.fn(async () => ({
  created: [], roleChanged: [], enabled: [], disabled: [], skippedNoEmail: [], pendingHandoff: [],
}));
const desired = { users: [] as Array<{ username: string; email: string; role: string }>, skippedNoEmail: [] as string[] };
const roster: Array<{ username: string; providerUserId: string }> = [];
const identityByName = new Map<string, { pk: number; username: string } | null>();

jest.mock("@/lib/app-accounts/reconcile", () => ({ syncAppUsers: (...a: unknown[]) => mockSyncAppUsers(...(a as [])) }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: async () => ({ users: {}, groups: {}, sha: "", raw: "" }) }));
jest.mock("@/lib/app-accounts/policy", () => ({ computeDesiredAppUsers: () => desired }));
jest.mock("@/lib/app-accounts/store", () => ({ openBaoAppAccountStore: { loadRoster: async () => roster } }));
jest.mock("@/lib/users/resolve-identity", () => ({
  resolveAuthentikIdentity: async (username: string) => identityByName.get(username) ?? null,
}));
jest.mock("@/lib/app-accounts/notify", () => ({ consoleAccountNotifier: {} }));
jest.mock("@/lib/jellyfin/provider", () => ({ JellyfinAccountProvider: class {} }));

import { syncJellyfinUsers } from "@/lib/jellyfin/access";

/** The `users` array handed to syncAppUsers on the most recent call. */
function syncedUsernames(): string[] {
  const arg = mockSyncAppUsers.mock.calls.at(-1)?.[1] as { users: Array<{ username: string }> };
  return arg.users.map((u) => u.username).sort();
}

describe("syncJellyfinUsers — enrollment gate + canonical username", () => {
  beforeEach(() => {
    mockSyncAppUsers.mockClear();
    desired.users = [];
    roster.length = 0;
    identityByName.clear();
  });

  test("enrolled user is provisioned under the canonical Authentik username, not the drifted key", async () => {
    desired.users = [{ username: "koenluppers", email: "koen@example.com", role: "user" }];
    identityByName.set("koenluppers", { pk: 7, username: "KoenLuppers" }); // AK chose CamelCase

    await syncJellyfinUsers();

    expect(syncedUsernames()).toEqual(["KoenLuppers"]);
  });

  test("granted-but-not-yet-enrolled user is deferred (no account created)", async () => {
    desired.users = [{ username: "newbie", email: "new@example.com", role: "user" }];
    identityByName.set("newbie", null); // no Authentik identity yet
    // roster empty → not previously provisioned

    await syncJellyfinUsers();

    expect(syncedUsernames()).toEqual([]);
  });

  test("already-provisioned account is kept even when the Authentik lookup misses (no false-revoke)", async () => {
    desired.users = [{ username: "existing", email: "e@example.com", role: "user" }];
    identityByName.set("existing", null); // transient Authentik miss
    roster.push({ username: "existing", providerUserId: "jf-1" }); // already has an account

    await syncJellyfinUsers();

    expect(syncedUsernames()).toEqual(["existing"]);
  });

  test("mixed set: enrolled canonicalized, pending dropped, provisioned kept", async () => {
    desired.users = [
      { username: "alice", email: "a@example.com", role: "user" },
      { username: "bob", email: "b@example.com", role: "user" },
      { username: "carol", email: "c@example.com", role: "user" },
    ];
    identityByName.set("alice", { pk: 1, username: "Alice" }); // enrolled → canonical
    identityByName.set("bob", null); // pending, not provisioned → dropped
    identityByName.set("carol", null); // pending BUT already provisioned → kept
    roster.push({ username: "carol", providerUserId: "jf-2" });

    await syncJellyfinUsers();

    expect(syncedUsernames()).toEqual(["Alice", "carol"]);
  });
});
