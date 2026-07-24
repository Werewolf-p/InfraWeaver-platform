/** @jest-environment node */
// The Media write route: per-verb RBAC. Every write verb needs `wordpress:write`
// EXCEPT `delete`, which performs a permanent wp_delete_attachment(force) + bucket
// removal and therefore demands `wordpress:admin`. Proves a write-but-not-admin
// principal is refused `delete` (403, never reaches the signed channel) yet can
// still run a normal write verb (optimize).
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/lib/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: jest.fn(() => true) }));
jest.mock("@/lib/api-helpers", () => ({ checkSameOrigin: jest.fn(() => true) }));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ WpPodExecError: class WpPodExecError extends Error {} }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  deleteMediaAsset: jest.fn(),
  editMediaImage: jest.fn(),
  getMediaAsset: jest.fn(),
  getMediaUsage: jest.fn(),
  listMedia: jest.fn(),
  mediaFolderOp: jest.fn(),
  mediaStatus: jest.fn(),
  mediaTree: jest.fn(),
  offloadMedia: jest.fn(),
  optimizeMedia: jest.fn(),
  protectMedia: jest.fn(),
  restoreMedia: jest.fn(),
  updateMediaMeta: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/wordpress-rbac", () => ({
  getWordpressAccessContext: jest.fn(),
  hasWordpressPermission: jest.fn(),
}));

import { mediaWriteHandler } from "@/addons/wordpress-manager/api/media-handlers";
import { auth } from "@/lib/auth";
import { checkSameOrigin } from "@/lib/api-helpers";
import { getWordpressAccessContext, hasWordpressPermission } from "@/addons/wordpress-manager/lib/wordpress-rbac";
import { deleteMediaAsset, optimizeMedia } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";

const authMock = auth as jest.MockedFunction<typeof auth>;
const originMock = checkSameOrigin as jest.MockedFunction<typeof checkSameOrigin>;
const ctxMock = getWordpressAccessContext as jest.MockedFunction<typeof getWordpressAccessContext>;
const permMock = hasWordpressPermission as jest.MockedFunction<typeof hasWordpressPermission>;
const deleteMock = deleteMediaAsset as jest.MockedFunction<typeof deleteMediaAsset>;
const optimizeMock = optimizeMedia as jest.MockedFunction<typeof optimizeMedia>;

const SITE = "blog";

function req(body: unknown) {
  return {
    url: `http://console.test/api/wordpress/sites/${SITE}/media`,
    json: async () => body,
  } as unknown as Parameters<typeof mediaWriteHandler>[0];
}

/** Grant every wordpress permission EXCEPT admin (permission is the 4th arg). */
function grantWriteNotAdmin(): void {
  permMock.mockImplementation((_g, _u, _r, permission) => permission !== "wordpress:admin");
}

beforeEach(() => {
  jest.clearAllMocks();
  originMock.mockReturnValue(true);
  authMock.mockResolvedValue({} as never);
  ctxMock.mockResolvedValue({
    groups: [],
    username: "alice",
    roleAssignments: [],
    isAdmin: false,
  } as Awaited<ReturnType<typeof getWordpressAccessContext>>);
});

describe("mediaWriteHandler — per-verb RBAC tier", () => {
  test("delete demands wordpress:admin — a write-but-not-admin principal is refused (403)", async () => {
    grantWriteNotAdmin();
    const res = await mediaWriteHandler(req({ verb: "delete", params: { id: 12, confirm: true } }), SITE);
    expect(res.status).toBe(403);
    // Never reaches the signed channel — nothing is destroyed.
    expect(deleteMock).not.toHaveBeenCalled();
    // The permission demanded for delete is admin, not write.
    const deleteChecks = permMock.mock.calls.filter((c) => c[3] === "wordpress:admin");
    expect(deleteChecks.length).toBeGreaterThan(0);
  });

  test("delete succeeds for an admin principal", async () => {
    permMock.mockReturnValue(true);
    deleteMock.mockResolvedValue({ ok: true, deleted: true, id: 12 } as never);
    const res = await mediaWriteHandler(req({ verb: "delete", params: { id: 12, confirm: true } }), SITE);
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith(SITE, { id: 12, confirm: true });
  });

  test("a normal write verb (optimize) only needs wordpress:write — same non-admin principal passes", async () => {
    grantWriteNotAdmin();
    optimizeMock.mockResolvedValue({ ok: true } as never);
    const res = await mediaWriteHandler(req({ verb: "optimize", params: { ids: [1, 2] } }), SITE);
    expect(res.status).toBe(200);
    expect(optimizeMock).toHaveBeenCalledWith(SITE, { ids: [1, 2] });
    // optimize is gated on write, never admin.
    for (const call of permMock.mock.calls) expect(call[3]).toBe("wordpress:write");
  });
});
