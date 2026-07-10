/**
 * @jest-environment node
 *
 * Route-level pins for the case-canonicalization invariant.
 *
 * `lib/nas/canonical.ts` implements the primitives correctly and its own unit
 * tests pass — but the primitives only protect anything if the ROUTES use them.
 * Both bugs pinned here shipped with a green suite because every existing test
 * exercised the library layer in isolation.
 *
 *   GET  authorized against a lowercase scope, then listed the appliance with the
 *        caller's RAW casing. With `media` and `Media` both on disk, a grant on
 *        `media` listed `Media` — a directory nobody granted.
 *   POST awaited `resolveCanonicalSubfolder` only for its throw and discarded the
 *        canonical spelling, then mkdir'd the raw path. Creating `movies/newsub`
 *        where `Movies` exists manufactured a real `movies` sibling — the exact
 *        ambiguity the route's own comment claims can "never be introduced".
 *
 * Only the appliance calls are mocked. The authorization decision, the scope
 * arithmetic and the canonicalization walk are all real.
 */

import type { RoleAssignment } from "@/lib/rbac";

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  NextRequest: class {},
}));

jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "scoped@example.com" } })) }));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(async () => {}) }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: jest.fn(() => true), rateLimitKey: jest.fn(() => "k") }));
jest.mock("@/lib/nas/mount-credentials", () => ({
  ensureProviderSmbCredentials: jest.fn(async () => []),
  truenasConnectionFor: jest.fn(() => ({})),
}));
jest.mock("@/lib/nas/smb-accounts", () => ({
  grantTruenasFolderAccess: jest.fn(async () => {}),
  grantTruenasTraversal: jest.fn(async () => {}),
}));

jest.mock("@/lib/nas/providers", () => ({
  // `nfs` backend keeps the SMB account-minting branch out of the POST path.
  getResolvedNasProvider: jest.fn(async () => ({
    id: "truenas", kind: "truenas", host: "10.0.0.1", port: 443, backends: ["nfs"],
  })),
  resolveNasCredentials: jest.fn(async () => ({ apiKey: "k" })),
}));

/** Directory name -> its child directory names. "" is the share root. */
let disk: Record<string, string[]>;
const createdPaths: string[] = [];

jest.mock("@/lib/nas/folders", () => {
  const actual = jest.requireActual("@/lib/nas/folders");
  return {
    ...actual,
    listNasFolders: jest.fn(async (_t: unknown, _c: unknown, _s: string, path: string) =>
      (disk[path] ?? []).map((name) => ({ name, subfolder: path ? `${path}/${name}` : name }))),
    createNasFolder: jest.fn(async (_t: unknown, _c: unknown, _s: string, path: string) => {
      createdPaths.push(path);
      return { created: [path] };
    }),
    resolveNasSharePath: jest.fn(async () => "/mnt/Main/infraweaver"),
  };
});

const rbacContext = { current: {} as Record<string, unknown> };
// The real module reaches k8s (ESM) through access-store. Re-implement its three
// pure entry points on top of `lib/rbac.ts`, which has no imports at all, so the
// permission arithmetic under test stays genuine.
jest.mock("@/lib/session-rbac", () => {
  const { getEffectivePermissions } = jest.requireActual("@/lib/rbac");
  type Ctx = { groups: string[]; username: string; roleAssignments: unknown[]; extraPermissions: string[] };
  const effective = (ctx: Ctx, scope = "/") => {
    const perms: Set<string> = getEffectivePermissions(ctx.groups, ctx.username, ctx.roleAssignments, scope);
    for (const p of ctx.extraPermissions) perms.add(p);
    return perms;
  };
  return {
    getSessionRBACContext: jest.fn(async () => rbacContext.current),
    getSessionEffectivePermissions: (ctx: Ctx, scope = "/") => effective(ctx, scope),
    hasSessionPermission: (ctx: Ctx, permission: string, scope = "/") => {
      const perms = effective(ctx, scope);
      return perms.has("*") || perms.has(permission);
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GET, POST } = require("@/app/api/nas/folders/route");

const PROVIDER = "truenas";
const SHARE = "infraweaver";

function grantOn(scope: string, roleId: string): RoleAssignment {
  return {
    id: "ra-1", roleId, scope, principalType: "user", principalId: "scoped-user",
    grantedBy: "admin@example.com", grantedAt: "2026-01-01T00:00:00.000Z",
  } as RoleAssignment;
}

/** A user whose ONLY storage authority is one scoped grant — no blanket nas:*. */
function scopedUser(scope: string, roleId = "storage-viewer") {
  return { groups: [], username: "scoped-user", roleAssignments: [grantOn(scope, roleId)], extraPermissions: [] };
}

const owner = { groups: [], username: "remon", roleAssignments: [], extraPermissions: ["*"] };

function getReq(path: string) {
  const url = new URL(`https://c.test/api/nas/folders?provider=${PROVIDER}&share=${SHARE}&path=${encodeURIComponent(path)}`);
  return { nextUrl: url } as never;
}
function postReq(path: string) {
  return { json: async () => ({ provider: PROVIDER, share: SHARE, path }) } as never;
}

beforeEach(() => {
  disk = {};
  createdPaths.length = 0;
});

describe("GET /api/nas/folders — a grant on `media` must not list `Media`", () => {
  test("fails closed (409) when the requested path is case-ambiguous on disk", async () => {
    // Both spellings exist. They collapse to the single scope `.../media`.
    disk[""] = ["media", "Media"];
    disk["Media"] = ["private-tax-returns"];
    disk["media"] = ["public-movies"];
    rbacContext.current = scopedUser(`/nas/${PROVIDER}/${SHARE}/media`);

    const res = await GET(getReq("Media"));

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/ambiguous/i);
    // The bug: 200 + { folders: [{ name: "private-tax-returns" }] }.
    expect(JSON.stringify(res.body)).not.toContain("private-tax-returns");
  });

  test("an unambiguous folder still resolves, and reports its real on-disk casing", async () => {
    // Only `Media` exists, so lowercase-scope <-> folder is still a bijection.
    disk[""] = ["Media"];
    disk["Media"] = ["public-movies"];
    rbacContext.current = scopedUser(`/nas/${PROVIDER}/${SHARE}/media`);

    const res = await GET(getReq("Media"));

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("Media");
    expect(res.body.folders.map((f: { name: string }) => f.name)).toEqual(["public-movies"]);
  });

  test("a scoped grant on one folder still cannot traverse a sibling", async () => {
    disk[""] = ["media", "finance"];
    rbacContext.current = scopedUser(`/nas/${PROVIDER}/${SHARE}/media`);

    const res = await GET(getReq("finance"));

    expect(res.status).toBe(403);
  });
});

describe("POST /api/nas/folders — must never manufacture a case-variant sibling", () => {
  test("a wrong-cased ANCESTOR creates under the real folder, not a new sibling", async () => {
    disk[""] = ["Movies"];
    disk["Movies"] = [];
    rbacContext.current = owner;

    const res = await POST(postReq("movies/newsub"));

    expect(res.status).toBe(200);
    // The bug: mkdir "movies/newsub" -> a second, case-variant "movies" appears.
    expect(createdPaths).toEqual(["Movies/newsub"]);
    expect(res.body.path).toBe("Movies/newsub");
  });

  test("a leaf that case-collides with an existing sibling is still refused (409)", async () => {
    disk[""] = ["media"];
    rbacContext.current = owner;

    const res = await POST(postReq("Media"));

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/collides/i);
    expect(createdPaths).toEqual([]);
  });

  test("an unambiguous new folder is created with the casing the caller asked for", async () => {
    disk[""] = ["media"];
    rbacContext.current = owner;

    const res = await POST(postReq("Archive"));

    expect(res.status).toBe(200);
    expect(createdPaths).toEqual(["Archive"]);
  });
});
