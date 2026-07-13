/**
 * @jest-environment node
 *
 * Regression pin for the offboard token-revocation scope (commit 0573921a).
 *
 * Authentik SILENTLY IGNORES an unrecognized list filter and returns EVERY row.
 * The original offboard loop listed `/core/tokens/?user=<username>` — a string
 * where the `user` filter wants a pk — so the ignored filter returned all tokens
 * and the loop deleted the console's own `iw-admin-token` and the embedded
 * outpost's API token: a self-inflicted outage.
 *
 * Two independent defenses must both hold, so both are pinned here:
 *   1. The list request is scoped with `?user__username=` (the filter Authentik
 *      actually honors), never a bare `?user=`.
 *   2. Defense in depth — even when the list response contains foreign tokens
 *      (exactly what the ignored filter produced), only tokens whose `.user`
 *      equals the target user's pk are DELETEd. Admin/outpost tokens survive.
 *
 * Only Authentik and the downstream deprovision calls are mocked. The route's
 * own scoping arithmetic is real.
 */

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  NextRequest: class {},
}));

jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "admin@example.com" } })) }));
jest.mock("@/lib/session-rbac", () => ({
  getSessionRBACContext: jest.fn(async () => ({})),
  hasAnySessionPermission: jest.fn(() => true),
}));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(async () => {}) }));
jest.mock("@/lib/utils", () => ({ safeError: (e: unknown) => String((e as { message?: string })?.message ?? e) }));
jest.mock("@/lib/jellyfin/access", () => ({
  offboardJellyfinUser: jest.fn(async () => ({ message: "no jellyfin account" })),
}));
jest.mock("@/lib/nextcloud/deprovision", () => ({
  deprovisionNextcloudUser: jest.fn(async () => ({ message: "no nextcloud user" })),
}));
jest.mock("@/lib/users-config", () => ({
  loadUsersConfig: jest.fn(async () => ({ users: {}, sha: "sha" })),
  saveUsersConfig: jest.fn(async () => {}),
}));

const findUserByUsername = jest.fn();
const findUserByEmail = jest.fn(async () => null);
const authentikFetch = jest.fn();
jest.mock("@/lib/authentik", () => ({
  findUserByUsername: (...a: unknown[]) => findUserByUsername(...a),
  findUserByEmail: (...a: unknown[]) => findUserByEmail(...a),
  authentikFetch: (...a: unknown[]) => authentikFetch(...a),
}));

const TARGET_PK = 42;
const TARGET = "victim";

/** A minimal fetch Response stand-in that authentikFetch would otherwise return. */
function res(ok: boolean, body: unknown = {}, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body };
}

type Call = { path: string; method: string };
let calls: Call[];

/**
 * Route authentikFetch by (path, method). The token LIST deliberately returns
 * foreign tokens alongside the target's — the exact payload the ignored filter
 * produced — so the client-side pk guard is what's under test.
 */
function installAuthentik(tokenList: Array<{ identifier: string; user?: number }>) {
  calls = [];
  authentikFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? "GET";
    calls.push({ path, method });
    if (path.startsWith("/core/tokens/?")) return res(true, { results: tokenList });
    // disable PATCH, per-token DELETE, group remove_user POST all just succeed.
    return res(true, {});
  });
  findUserByUsername.mockResolvedValue({
    pk: TARGET_PK,
    email: "victim@example.com",
    groups: [],
    is_active: true,
  });
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { POST } = require("@/app/api/users/[username]/offboard/route");

function invoke(username = TARGET) {
  return POST({} as never, { params: Promise.resolve({ username }) });
}

const deletes = () =>
  calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.path));
const revokeStep = (body: { steps: Array<{ name: string; message: string }> }) =>
  body.steps.find((s) => s.name === "Revoke tokens");

beforeEach(() => {
  jest.clearAllMocks();
});

describe("offboard token revocation is scoped to the target user's pk", () => {
  test("lists tokens with `user__username=`, never a bare `user=` filter", async () => {
    installAuthentik([{ identifier: "victim-token", user: TARGET_PK }]);

    await invoke();

    const list = calls.find((c) => c.path.startsWith("/core/tokens/?"));
    expect(list).toBeDefined();
    expect(list!.path).toContain(`user__username=${TARGET}`);
    // The regression: `?user=<username>` — an ignored filter that returns everything.
    expect(list!.path).not.toMatch(/[?&]user=/);
  });

  test("deletes ONLY the target's token when the list also returns admin/outpost tokens", async () => {
    // Exactly the payload the ignored filter produced: everyone's tokens.
    installAuthentik([
      { identifier: "victim-token", user: TARGET_PK },
      { identifier: "iw-admin-token", user: 1 }, // the console's own runtime token
      { identifier: "ak-outpost-token", user: 7 }, // the embedded outpost's API token
    ]);

    const { body, status } = await invoke();

    expect(status).toBe(200);
    // Only the victim's token is DELETEd; the shared tokens that caused the
    // outage are never touched.
    expect(deletes()).toEqual(["/core/tokens/victim-token/"]);
    expect(deletes()).not.toContain("/core/tokens/iw-admin-token/");
    expect(deletes()).not.toContain("/core/tokens/ak-outpost-token/");
    expect(revokeStep(body)?.message).toBe("Revoked 1 token(s)");
  });

  test("a token with no owner (undefined .user) is never deleted", async () => {
    installAuthentik([
      { identifier: "victim-token", user: TARGET_PK },
      { identifier: "orphan-token" }, // .user undefined — must not match pk
    ]);

    await invoke();

    expect(deletes()).toEqual(["/core/tokens/victim-token/"]);
  });

  test("target with zero tokens deletes nothing and still succeeds", async () => {
    installAuthentik([
      { identifier: "iw-admin-token", user: 1 },
      { identifier: "ak-outpost-token", user: 7 },
    ]);

    const { body } = await invoke();

    expect(deletes()).toEqual([]);
    expect(revokeStep(body)?.message).toBe("Revoked 0 token(s)");
  });
});

/** Invoke with a real request body (drives the deleteIdentity flag). */
function invokeWithBody(body: unknown, username = TARGET) {
  return POST({ json: async () => body } as never, { params: Promise.resolve({ username }) });
}
const stepNamed = (
  body: { steps: Array<{ name: string; success: boolean; message: string }> },
  name: string,
) => body.steps.find((s) => s.name === name);
const patchesUser = () => calls.filter((c) => c.path === `/core/users/${TARGET_PK}/` && c.method === "PATCH");
const deletesUser = () => calls.filter((c) => c.path === `/core/users/${TARGET_PK}/` && c.method === "DELETE");

describe("offboard tolerates a missing Authentik user (invited-but-never-enrolled / local-only)", () => {
  test("does not 404; skips SSO teardown but still deprovisions app accounts + config", async () => {
    const { offboardJellyfinUser } = require("@/lib/jellyfin/access");
    const { deprovisionNextcloudUser } = require("@/lib/nextcloud/deprovision");
    calls = [];
    authentikFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
      calls.push({ path, method: options?.method ?? "GET" });
      return res(true, {});
    });
    findUserByUsername.mockResolvedValue(null); // no SSO identity

    const { body, status } = await invokeWithBody({ deleteIdentity: true });

    expect(status).toBe(200);
    // No Authentik calls at all — nothing to disable, delete, revoke, or unbind.
    expect(calls).toEqual([]);
    // App-account + config cleanup still runs so nothing local is left behind.
    expect(offboardJellyfinUser).toHaveBeenCalledWith(TARGET);
    expect(deprovisionNextcloudUser).toHaveBeenCalledWith(TARGET);
    expect(stepNamed(body, "Authentik account")?.success).toBe(true);
  });
});

describe("delete vs offboard identity action", () => {
  test("deleteIdentity=true HARD-DELETEs the Authentik user, never merely disables it", async () => {
    installAuthentik([]);

    const { body, status } = await invokeWithBody({ deleteIdentity: true });

    expect(status).toBe(200);
    expect(deletesUser()).toHaveLength(1);
    expect(patchesUser()).toHaveLength(0);
    expect(stepNamed(body, "Delete Authentik account")?.success).toBe(true);
    expect(stepNamed(body, "Disable account")).toBeUndefined();
  });

  test("no deleteIdentity flag disables the account and retains it for audit", async () => {
    installAuthentik([]);

    const { body } = await invokeWithBody({});

    expect(patchesUser()).toHaveLength(1);
    expect(deletesUser()).toHaveLength(0);
    expect(stepNamed(body, "Disable account")?.success).toBe(true);
    expect(stepNamed(body, "Delete Authentik account")).toBeUndefined();
  });
});

/**
 * A username/case mismatch (or a post-invite rename) must not orphan the SSO
 * identity: when the username lookup misses, the route falls back to the roster
 * email so the real Authentik record is still torn down. Kept last in the file
 * because it overrides the shared loadUsersConfig mock.
 */
describe("offboard resolves the Authentik identity by email when the username misses", () => {
  const EMAIL_PK = 99;
  const { loadUsersConfig } = require("@/lib/users-config");

  afterEach(() => {
    // Restore the shared defaults these tests override, so nothing leaks.
    loadUsersConfig.mockResolvedValue({ users: {}, sha: "sha" });
    findUserByEmail.mockResolvedValue(null);
  });

  test("username lookup null + roster email → tears down the email-matched identity", async () => {
    loadUsersConfig.mockResolvedValue({
      users: { [TARGET]: { email: "victim@example.com" } },
      sha: "sha",
    });
    calls = [];
    authentikFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
      calls.push({ path, method: options?.method ?? "GET" });
      if (path.startsWith("/core/tokens/?")) return res(true, { results: [] });
      return res(true, {});
    });
    findUserByUsername.mockResolvedValue(null); // username no longer matches
    findUserByEmail.mockResolvedValue({ pk: EMAIL_PK, email: "victim@example.com", groups: [], is_active: true });

    const { body, status } = await invokeWithBody({ deleteIdentity: true });

    expect(status).toBe(200);
    expect(findUserByEmail).toHaveBeenCalledWith("victim@example.com");
    // The email-matched record is actually DELETEd — not silently orphaned.
    expect(calls.some((c) => c.path === `/core/users/${EMAIL_PK}/` && c.method === "DELETE")).toBe(true);
    expect(stepNamed(body, "Delete Authentik account")?.success).toBe(true);
  });

  test("email fallback is skipped when the username already resolves", async () => {
    loadUsersConfig.mockResolvedValue({
      users: { [TARGET]: { email: "victim@example.com" } },
      sha: "sha",
    });
    installAuthentik([]); // findUserByUsername resolves to TARGET_PK

    await invokeWithBody({});

    expect(findUserByEmail).not.toHaveBeenCalled();
    expect(patchesUser()).toHaveLength(1);
  });
});
