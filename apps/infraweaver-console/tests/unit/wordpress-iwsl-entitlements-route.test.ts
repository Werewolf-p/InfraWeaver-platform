/** @jest-environment node */
// The set-entitlements op route: RBAC gate (wordpress:admin) + dispatch. Mirrors
// the shared authorize/rate-limit path every managed op uses, so this proves the
// new action is gated exactly like set-rotation-policy and reaches the signed
// push only for an authorized admin.
jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/lib/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: jest.fn(() => true) }));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ WpPodExecError: class WpPodExecError extends Error {} }));
jest.mock("@/addons/wordpress-manager/lib/health-sweep", () => ({ runHealthSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/rotation-sweep", () => ({ runRotationSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/update-sweep", () => ({ runConnectorUpdateSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/metrics", () => ({ exportConnectorMetrics: jest.fn(), exportSiteMetrics: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/site-sweep", () => ({ runSiteSnapshotSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/connector-package", () => ({ buildConnectorPackage: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/channel-registry", () => ({
  getChannelRegistryDetail: jest.fn(),
  promoteChannel: jest.fn(),
  rollbackChannel: jest.fn(),
  setChannelVersion: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-enrollment", () => ({
  confirmFingerprint: jest.fn(),
  createExternalSite: jest.fn(),
  deleteExternalSite: jest.fn(),
  issueBundle: jest.fn(),
  listExternalSiteViews: jest.fn(),
  verifyExternalSite: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed", () => ({
  enrollManagedSite: jest.fn(),
  getManagedLink: jest.fn(),
  unlinkManagedSite: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  confirmSiteIdentity: jest.fn(),
  connectorDebug: jest.fn(),
  connectorHealthCheck: jest.fn(),
  deactivateConnector: jest.fn(),
  externalConnectorHealthCheck: jest.fn(),
  rotateConnectorKey: jest.fn(),
  setConnectorQuarantine: jest.fn(),
  setRotationPolicy: jest.fn(),
  setSiteChannel: jest.fn(),
  setSiteEntitlements: jest.fn(),
  setSiteTier: jest.fn(),
  updateConnectorPlugin: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/wordpress-rbac", () => ({
  getWordpressAccessContext: jest.fn(),
  hasWordpressPermission: jest.fn(),
}));

import { managedOpsHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";
import { auth } from "@/lib/auth";
import { getWordpressAccessContext, hasWordpressPermission } from "@/addons/wordpress-manager/lib/wordpress-rbac";
import { setSiteEntitlements, setSiteTier } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";

const authMock = auth as jest.MockedFunction<typeof auth>;
const ctxMock = getWordpressAccessContext as jest.MockedFunction<typeof getWordpressAccessContext>;
const permMock = hasWordpressPermission as jest.MockedFunction<typeof hasWordpressPermission>;
const setEntMock = setSiteEntitlements as jest.MockedFunction<typeof setSiteEntitlements>;
const setTierMock = setSiteTier as jest.MockedFunction<typeof setSiteTier>;

function req(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof managedOpsHandler>[0];
}

const SITE = "blog";

beforeEach(() => {
  jest.clearAllMocks();
  ctxMock.mockResolvedValue({ groups: [], username: "alice", roleAssignments: [], isAdmin: false } as Awaited<ReturnType<typeof getWordpressAccessContext>>);
});

describe("managedOpsHandler — set-entitlements RBAC", () => {
  test("401 when unauthenticated (no signed push)", async () => {
    authMock.mockResolvedValue(null as never);
    const res = await managedOpsHandler(req({ action: "set-entitlements", entitlements: { plus: true } }), SITE);
    expect(res.status).toBe(401);
    expect(setEntMock).not.toHaveBeenCalled();
  });

  test("403 when the session lacks wordpress:admin", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(false);
    const res = await managedOpsHandler(req({ action: "set-entitlements", entitlements: { plus: true } }), SITE);
    expect(res.status).toBe(403);
    expect(setEntMock).not.toHaveBeenCalled();
  });

  test("admin grants → dispatches setSiteEntitlements and returns the saved map", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    setEntMock.mockResolvedValue({ flags: { plus: true }, updatedAt: "2026-07-19T00:00:00.000Z", updatedBy: "alice" });

    const res = await managedOpsHandler(req({ action: "set-entitlements", entitlements: { plus: true } }), SITE);

    expect(res.status).toBe(200);
    expect(setEntMock).toHaveBeenCalledWith(SITE, { plus: true }, "alice");
    await expect(res.json()).resolves.toEqual({ entitlements: { flags: { plus: true }, updatedAt: "2026-07-19T00:00:00.000Z", updatedBy: "alice" } });
  });

  test("400 when the entitlements payload is missing", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    const res = await managedOpsHandler(req({ action: "set-entitlements" }), SITE);
    expect(res.status).toBe(400);
    expect(setEntMock).not.toHaveBeenCalled();
  });

  test("wordpress:admin is the permission demanded (parity with rotate/set-rotation-policy)", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    setEntMock.mockResolvedValue({ flags: { plus: false }, updatedAt: "t", updatedBy: "alice" });

    await managedOpsHandler(req({ action: "set-entitlements", entitlements: { plus: false } }), SITE);

    // Every hasWordpressPermission call for this op must ask for wordpress:admin.
    expect(permMock).toHaveBeenCalled();
    for (const call of permMock.mock.calls) {
      expect(call[3]).toBe("wordpress:admin");
    }
  });
});

describe("managedOpsHandler — set-tier", () => {
  test("admin assigns a known tier → dispatches setSiteTier", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    setTierMock.mockResolvedValue({ flags: { plus: true }, updatedAt: "t", updatedBy: "alice", tier: "care_pro" });

    const res = await managedOpsHandler(req({ action: "set-tier", tier: "care_pro" }), SITE);

    expect(res.status).toBe(200);
    expect(setTierMock).toHaveBeenCalledWith(SITE, "care_pro", "alice");
    for (const call of permMock.mock.calls) expect(call[3]).toBe("wordpress:admin");
  });

  test("400 on an unknown tier id (never reaches the signed push)", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(true);
    const res = await managedOpsHandler(req({ action: "set-tier", tier: "enterprise" }), SITE);
    expect(res.status).toBe(400);
    expect(setTierMock).not.toHaveBeenCalled();
  });

  test("403 without wordpress:admin (no signed push)", async () => {
    authMock.mockResolvedValue({} as never);
    permMock.mockReturnValue(false);
    const res = await managedOpsHandler(req({ action: "set-tier", tier: "free" }), SITE);
    expect(res.status).toBe(403);
    expect(setTierMock).not.toHaveBeenCalled();
  });
});
