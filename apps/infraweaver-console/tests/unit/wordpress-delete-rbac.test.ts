/** @jest-environment node */
// §12.6 — deleteSiteHandler is the console entry point for the destructive site
// teardown, so it must enforce the same `wordpress:admin` gate as every other
// destructive op, reject the unauthenticated, and only then run (and audit) the
// teardown. The handler pulls in the whole provisioning import graph, so the
// heavy collaborators are stubbed and the test exercises only the gate + wiring.

const authMock = jest.fn();
const hasPerm = jest.fn();
const teardownSite = jest.fn();
const auditLog = jest.fn();

// NextResponse.json → a plain envelope so we can read status + body without the
// web Request/Response globals the real implementation needs.
jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, init }) },
}));

jest.mock("@/lib/auth", () => ({ auth: () => authMock() }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true }));
jest.mock("@/addons/wordpress-manager/lib/wordpress-rbac", () => ({
  getWordpressAccessContext: async () => ({ username: "tester", groups: [], roleAssignments: [], isAdmin: false }),
  hasWordpressPermission: (...args: unknown[]) => hasPerm(...args),
  WORDPRESS_NAMESPACE: "wordpress",
}));
jest.mock("@/addons/wordpress-manager/lib/site-teardown", () => ({ teardownSite: (...args: unknown[]) => teardownSite(...args) }));
jest.mock("@/lib/audit-log", () => ({ auditLog: (...args: unknown[]) => auditLog(...args) }));
jest.mock("@/addons/wordpress-manager/lib/naming", () => ({ isValidSiteId: () => true, isValidSiteName: () => true }));

// Heavy/unused modules handlers.ts imports at load time — stubbed so the import
// graph resolves without dragging in @kubernetes/client-node, Authentik, etc.
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({
  createSite: jest.fn(), listSites: jest.fn(), listSitePods: jest.fn(), listInstalledPlugins: jest.fn(),
  setPlugins: jest.fn(), updateAllPlugins: jest.fn(), getMaintenanceMode: jest.fn(), setMaintenanceMode: jest.fn(),
  enableSso: jest.fn(), setProtection: jest.fn(), getSiteHealth: jest.fn(), syncSiteWpUsers: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ WpPodExecError: class WpPodExecError extends Error {} }));
jest.mock("@/addons/wordpress-manager/lib/access", () => ({ ensureSiteAccess: jest.fn(), listSiteAccessUsers: jest.fn(), siteAccessGroupName: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/access-policy", () => ({ computeSiteWordpressUsers: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/config", () => ({ listDomains: jest.fn(), internalSubdomain: jest.fn(), isAllowedDomain: jest.fn() }));
jest.mock("@/lib/users-config", () => ({ loadUsersConfig: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/overview", () => ({ getCachedManageOverview: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/panel-data", () => ({ getCachedManagePanel: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/fleet/aggregate", () => ({ getCachedFleet: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/capabilities", () => ({ isManagePanelId: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/manage/actions", () => ({ actionPermission: jest.fn(), manageActionSchema: {}, runManageAction: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/plugins", () => ({ PLUGIN_CATALOG: [] }));

import { deleteSiteHandler } from "@/addons/wordpress-manager/api/handlers";

type Envelope = { body: { ok?: boolean; error?: string; steps?: unknown[] }; init?: { status?: number } };

const SITE = "blog";

beforeEach(() => {
  authMock.mockReset();
  hasPerm.mockReset();
  teardownSite.mockReset();
  auditLog.mockReset().mockResolvedValue(undefined);
});

describe("deleteSiteHandler RBAC gate", () => {
  test("401 when unauthenticated — teardown never runs", async () => {
    authMock.mockResolvedValue(null);

    const res = (await deleteSiteHandler(SITE)) as unknown as Envelope;

    expect(res.init?.status).toBe(401);
    expect(teardownSite).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  test("403 when the session lacks wordpress:admin — teardown never runs", async () => {
    authMock.mockResolvedValue({ user: { name: "tester" } });
    hasPerm.mockReturnValue(false);

    const res = (await deleteSiteHandler(SITE)) as unknown as Envelope;

    expect(res.init?.status).toBe(403);
    // The gate is specifically wordpress:admin.
    expect(hasPerm).toHaveBeenCalledWith(expect.anything(), "tester", expect.anything(), "wordpress:admin", expect.anything());
    expect(teardownSite).not.toHaveBeenCalled();
  });

  test("runs the teardown and audits success when wordpress:admin is granted", async () => {
    authMock.mockResolvedValue({ user: { name: "tester" } });
    hasPerm.mockReturnValue(true);
    teardownSite.mockResolvedValue({ site: SITE, ok: true, steps: [{ step: "pvc/blog-wp-data", status: "removed" }] });

    const res = (await deleteSiteHandler(SITE)) as unknown as Envelope;

    expect(teardownSite).toHaveBeenCalledWith(SITE);
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(
      "wordpress:delete-site",
      "tester",
      expect.stringContaining(`deleted site ${SITE}`),
      expect.objectContaining({ result: "success", resource: `wordpress/${SITE}` }),
    );
  });

  test("a partial teardown returns 200 with ok:false and audits a failure", async () => {
    authMock.mockResolvedValue({ user: { name: "tester" } });
    hasPerm.mockReturnValue(true);
    teardownSite.mockResolvedValue({
      site: SITE,
      ok: false,
      steps: [{ step: "pvc/blog-wp-data", status: "failed", detail: "boom" }],
    });

    const res = (await deleteSiteHandler(SITE)) as unknown as Envelope;

    expect(res.init?.status ?? 200).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(
      "wordpress:delete-site",
      "tester",
      expect.any(String),
      expect.objectContaining({ result: "failure" }),
    );
  });
});
