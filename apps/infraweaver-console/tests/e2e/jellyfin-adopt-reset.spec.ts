// Regression for the Jellyfin adopt -> reset recovery flow (lib/jellyfin/access.ts).
//
// The orphan window this guards: a grant's `createUser` lands but `addRosterEntry`
// does not, so a real Jellyfin account exists under a still-authorized username that
// no later reconcile can disable — and whose password was lost with the failed
// provision. `syncJellyfinUsers` must ADOPT it (re-roster, restoring revocability)
// and surface it as `adopted` (the panel's amber prompt), never silently reset it;
// `resetJellyfinCredential` is the audited admin action that mints a usable password.
//
// This is a true end-to-end: it drives the REAL adapter chain — client -> provider
// -> reconcile -> OpenBao store -> access.ts — over HTTP against in-process fakes for
// Jellyfin, OpenBao (KV v2) and the GitHub users.yaml source. Nothing is stubbed
// inside the module under test, so a regression in any layer fails here. The two
// entrypoints are exactly what the console UI calls:
//   - the Sync button (RefreshCw)  -> PUT  /api/jellyfin/access     -> syncJellyfinUsers()
//   - the reset button (KeyRound)  -> POST /api/jellyfin/credential -> resetJellyfinCredential()
//
// It never launches a browser (no `page` fixture), so CI runs it without installing
// Playwright browsers; `server-only` is neutralised by the --require shim the npm
// script preloads (see package.json `test:e2e:jellyfin`).
import { test, expect } from "@playwright/test";
import { startFakeBackends, type FakeBackends } from "./support/fake-backends";
import { openBaoAppAccountStore, readAppAccountCredential } from "@/lib/app-accounts/store";
import type { RosterEntry } from "@/lib/app-accounts/types";
import {
  resetJellyfinCredential,
  syncJellyfinUsers,
  UnmanagedJellyfinAccountError,
} from "@/lib/jellyfin/access";

test.describe.configure({ mode: "serial" });

const APP = "jellyfin";
const SERVICE_API_KEY = "svc-api-key";
const ORIGINAL_PASSWORD = "OriginalJellyfinPw-0001";

// alice is granted jellyfin-user at /jellyfin, so RBAC keeps authorizing her local
// account throughout — the precondition for adoption (an orphan is only ever adopted
// while still authorized; a genuinely unmanaged account is never claimed).
const USERS_YAML = `users:
  alice:
    name: Alice Example
    email: alice@example.com
    role_assignments:
      - id: ra-alice-jellyfin
        roleId: jellyfin-user
        scope: /jellyfin
        principalType: user
        principalId: alice
        grantedBy: operator
        grantedAt: "2026-01-01T00:00:00.000Z"
groups: {}
`;

let fake: FakeBackends;

function rosterEntryFor(username: string): RosterEntry | undefined {
  const roster = fake.vaultRead(`platform/app-accounts/${APP}/roster`) as { entries?: RosterEntry[] } | undefined;
  return roster?.entries?.find((e) => e.username === username);
}

test.beforeAll(async () => {
  fake = await startFakeBackends({
    usersYaml: USERS_YAML,
    validApiKeys: [SERVICE_API_KEY],
    // "Onboarded": the wizard is already complete and alice's account already exists
    // (she was provisioned earlier). The service account authenticates with a stored,
    // still-valid API key, so no bootstrap wizard runs.
    jellyfinUsers: [
      { Id: "guid-service", Name: "infraweaver-service", password: "service-pw", IsAdministrator: true, IsDisabled: false },
      { Id: "guid-alice", Name: "alice", password: ORIGINAL_PASSWORD, IsAdministrator: false, IsDisabled: false },
    ],
    vault: {
      "platform/app-accounts/jellyfin/service-account": { apiKey: SERVICE_API_KEY },
      // alice starts as a healthy managed account (on the roster, credential stored).
      "platform/app-accounts/jellyfin/roster": {
        entries: [{ username: "alice", providerUserId: "guid-alice", provisionedAt: "2026-01-01T00:00:00.000Z", notifiedAt: "2026-01-01T00:00:00.000Z" }],
      },
      "platform/app-accounts/jellyfin/users/alice": { username: "alice", password: ORIGINAL_PASSWORD, email: "alice@example.com", createdAt: "2026-01-01T00:00:00.000Z" },
    },
  });

  // Point every adapter at the fakes. Read at call time by config.ts / store.ts /
  // git-provider.ts, so setting them here (before any function runs) is sufficient.
  process.env.JELLYFIN_URL = fake.baseUrl;
  process.env.JELLYFIN_PUBLIC_URL = "https://jellyfin.int.example.test";
  process.env.OPENBAO_ADDR = fake.baseUrl;
  process.env.OPENBAO_TOKEN = "test-token";
  process.env.GITHUB_API_URL = fake.baseUrl;
  process.env.GITHUB_TOKEN = "test-gh-token";
  process.env.GITHUB_REPO = "example/infra";
});

test.afterAll(async () => {
  await fake?.close();
});

test("adopts a roster-orphaned Jellyfin account, then reset makes it usable again", async () => {
  await test.step("orphan alice by dropping her roster entry (createUser landed, addRosterEntry didn't)", async () => {
    await openBaoAppAccountStore.removeRosterEntry(APP, "alice");
    expect(rosterEntryFor("alice")).toBeUndefined();
    // Her real Jellyfin account is untouched — that is precisely what makes her an
    // unrevocable orphan until adoption.
    expect(fake.jellyfinUsers().some((u) => u.Name === "alice")).toBe(true);
  });

  await test.step("Sync -> amber: the reconcile adopts her and reports it, without re-creating or resetting", async () => {
    const summary = await syncJellyfinUsers();

    // `adopted` is the exact value the panel turns into its amber warning.
    expect(summary.adopted).toContain("alice");
    // Adoption is a roster fix only: no duplicate account, no password churn.
    expect(summary.created).toEqual([]);
    expect(summary.disabled).toEqual([]);
    expect(fake.jellyfinUsers().filter((u) => u.Name === "alice")).toHaveLength(1);

    // She is back on the roster, tagged adopted-but-not-yet-handed-off.
    const entry = rosterEntryFor("alice");
    expect(entry?.adoptedAt).toBeTruthy();
    expect(entry?.notifiedAt).toBeUndefined();

    // Her password is still the lost original — adoption did NOT touch it.
    expect(await fake.authenticate("alice", ORIGINAL_PASSWORD)).toBe(200);
  });

  let newPassword = "";

  await test.step("KeyRound -> reset: mints a new password and records the hand-off", async () => {
    const result = await resetJellyfinCredential("alice");
    newPassword = result.password;

    expect(result.username).toBe("alice");
    expect(result.launchUrl).toBe("https://jellyfin.int.example.test");
    expect(newPassword.length).toBeGreaterThanOrEqual(16);
    expect(newPassword).not.toBe(ORIGINAL_PASSWORD);
  });

  await test.step("the new password authenticates and the old one is rejected", async () => {
    expect(await fake.authenticate("alice", newPassword)).toBe(200);
    expect(await fake.authenticate("alice", ORIGINAL_PASSWORD)).toBe(401);
  });

  await test.step("net-zero: one managed account, no duplicate, credential revealable, amber cleared", async () => {
    // No account was added or removed across the whole flow — still service + alice.
    const jellyfin = fake.jellyfinUsers();
    expect(jellyfin).toHaveLength(2);
    expect(jellyfin.filter((u) => u.Name === "alice")).toHaveLength(1);

    // The roster entry is now an ordinary managed one: adopted AND handed off.
    const entry = rosterEntryFor("alice");
    expect(entry?.adoptedAt).toBeTruthy();
    expect(entry?.notifiedAt).toBeTruthy();

    // The reset password is what a self-service reveal would now return.
    const revealed = await readAppAccountCredential(APP, "alice");
    expect(revealed?.password).toBe(newPassword);
    expect(revealed?.email).toBe("alice@example.com");

    // A follow-up reconcile is a clean no-op: the amber adopted signal is gone.
    const summary = await syncJellyfinUsers();
    expect(summary.adopted).toEqual([]);
    expect(summary.pendingHandoff).toEqual([]);
    expect(summary.created).toEqual([]);
    expect(summary.disabled).toEqual([]);
  });
});

test("reset refuses a name InfraWeaver does not manage (the route's 404 path)", async () => {
  // Resetting only ever touches roster-managed accounts — never a manual or app-native
  // one (e.g. the operator's own Jellyfin admin). The distinct error is what the
  // credential route answers 404 for instead of masking it as a 500.
  await expect(resetJellyfinCredential("ghost-not-on-roster")).rejects.toBeInstanceOf(UnmanagedJellyfinAccountError);
});
