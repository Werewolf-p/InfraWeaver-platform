/** @jest-environment node */
// §5 — confirmFingerprintHandler binds the canonical identity the instant the
// operator confirms the connector fingerprint by firing one signed health.check,
// instead of leaving `canonicalUrl` null until the first hourly sweep. The bind
// is best-effort: the link is already active and confirmed, so a health.check
// that throws must NOT fail the confirm (200 + the confirmed site still returns).
//
// The handler pulls in the whole IWSL import graph (k8s exec, sweeps, crypto),
// so every collaborator is mocked; the test exercises only the confirm→bind wiring.

const confirmFingerprint = jest.fn<Promise<{ siteId: string; canonicalUrl?: string }>, [string]>();
const externalConnectorHealthCheck = jest.fn<Promise<unknown>, [string]>();

// NextResponse.json → a plain envelope so we can read status + body without the
// web Request/Response globals the real implementation needs.
jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, init }) },
}));

// Pass auth + RBAC so control reaches the guarded body.
jest.mock("@/lib/auth", () => ({ auth: async () => ({ user: { name: "tester" } }) }));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true }));
jest.mock("@/addons/wordpress-manager/lib/wordpress-rbac", () => ({
  getWordpressAccessContext: async () => ({ username: "tester", groups: [], roleAssignments: [] }),
  hasWordpressPermission: () => true,
}));

// The two collaborators the confirm path actually calls.
jest.mock("@/addons/wordpress-manager/lib/iwsl-enrollment", () => ({
  confirmFingerprint: (siteId: string) => confirmFingerprint(siteId),
  createExternalSite: jest.fn(),
  deleteExternalSite: jest.fn(),
  issueBundle: jest.fn(),
  listExternalSiteViews: jest.fn(),
  verifyExternalSite: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  externalConnectorHealthCheck: (siteId: string) => externalConnectorHealthCheck(siteId),
  confirmSiteIdentity: jest.fn(),
  connectorDebug: jest.fn(),
  connectorHealthCheck: jest.fn(),
  deactivateConnector: jest.fn(),
  rotateConnectorKey: jest.fn(),
  setConnectorQuarantine: jest.fn(),
  updateConnectorPlugin: jest.fn(),
}));

// Heavy/unused modules the handler imports at load time — stubbed so the graph resolves.
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ WpPodExecError: class WpPodExecError extends Error {} }));
jest.mock("@/addons/wordpress-manager/lib/health-sweep", () => ({ runHealthSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/update-sweep", () => ({ runConnectorUpdateSweep: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/connector-package", () => ({ buildConnectorPackage: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed", () => ({
  enrollManagedSite: jest.fn(),
  getManagedLink: jest.fn(),
  unlinkManagedSite: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/naming", () => ({ isValidSiteId: () => true }));

import { confirmFingerprintHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

type Envelope = { body: { site?: unknown; error?: string }; init?: { status?: number } };

const SITE_ID = "11111111-1111-1111-1111-111111111111";
const CONFIRMED_SITE = { siteId: SITE_ID, canonicalUrl: "https://blog.example.com" };

describe("confirmFingerprintHandler — post-confirm identity bind (§5)", () => {
  beforeEach(() => {
    confirmFingerprint.mockReset().mockResolvedValue(CONFIRMED_SITE);
    externalConnectorHealthCheck.mockReset().mockResolvedValue(undefined);
  });

  test("fires a signed health.check after confirm and returns the confirmed site", async () => {
    const res = (await confirmFingerprintHandler(SITE_ID)) as unknown as Envelope;

    expect(confirmFingerprint).toHaveBeenCalledWith(SITE_ID);
    expect(externalConnectorHealthCheck).toHaveBeenCalledTimes(1);
    expect(externalConnectorHealthCheck).toHaveBeenCalledWith(SITE_ID);
    // The bind rides on the just-confirmed link, so confirm must run first.
    expect(confirmFingerprint.mock.invocationCallOrder[0]).toBeLessThan(
      externalConnectorHealthCheck.mock.invocationCallOrder[0],
    );
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.body.site).toEqual(CONFIRMED_SITE);
  });

  test("a thrown health.check still returns 200 with the confirmed site (best-effort bind)", async () => {
    externalConnectorHealthCheck.mockRejectedValue(new Error("pod unreachable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const res = (await confirmFingerprintHandler(SITE_ID)) as unknown as Envelope;

    expect(confirmFingerprint).toHaveBeenCalledWith(SITE_ID);
    expect(externalConnectorHealthCheck).toHaveBeenCalledTimes(1);
    expect(res.init?.status ?? 200).toBe(200);
    expect(res.body.site).toEqual(CONFIRMED_SITE);
    expect(res.body.error).toBeUndefined();

    warn.mockRestore();
  });
});
