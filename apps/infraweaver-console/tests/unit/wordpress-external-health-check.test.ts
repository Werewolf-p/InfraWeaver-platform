/** @jest-environment node */
// §5 phase-4 — signed health.check to an EXTERNAL site over the HTTPS command
// channel. The contract that matters: the response is verified against the
// pinned WP-PK exactly like the managed exec path, so (1) a valid signed reply
// populates connectorVersion for the update badge, and (2) a tampered reply —
// the machine-in-the-middle case this whole protocol exists for — quarantines
// the link and never trusts the (spoofable) version it carried.
jest.mock("server-only", () => ({}), { virtual: true });

// Heavy import-time deps of iwsl-managed-ops that the HTTP path never touches.
jest.mock("@/addons/wordpress-manager/lib/k8s-exec", () => ({ execInWpPod: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ findWpPodName: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/connector-package", () => ({ buildConnectorPackage: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed", () => ({ unlinkManagedSite: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-keys", () => ({
  loadOrCreateIwKeys: jest.fn(async () => ({ keys: {}, kid: 1 })),
}));

jest.mock("@/lib/outbound-url", () => ({ requestSafeExternalUrl: jest.fn() }));
jest.mock("@/lib/iwsl", () => ({
  createSignedCommand: jest.fn(() => ({ envelope: { nonce: "nonce-1" } })),
  verifySignedResponse: jest.fn(),
  wpKeyFingerprint: jest.fn(() => "fp"),
}));

jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: jest.fn(),
  mutateExternalSites: jest.fn(),
}));

import { externalConnectorHealthCheck } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";
import { listExternalSites, mutateExternalSites, type ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";
import { requestSafeExternalUrl } from "@/lib/outbound-url";
import { verifySignedResponse } from "@/lib/iwsl";

const listMock = listExternalSites as jest.MockedFunction<typeof listExternalSites>;
const mutateMock = mutateExternalSites as jest.MockedFunction<typeof mutateExternalSites>;
const fetchMock = requestSafeExternalUrl as jest.MockedFunction<typeof requestSafeExternalUrl>;
const verifyMock = verifySignedResponse as jest.MockedFunction<typeof verifySignedResponse>;

/** One confirmed, commandable external link — the only shape the probe accepts. */
function externalLink(overrides: Partial<ExternalSiteRecord> = {}): ExternalSiteRecord {
  return {
    siteId: "11111111-1111-1111-1111-111111111111",
    name: "Customer blog",
    url: "https://blog.example.com",
    state: "active",
    fingerprintConfirmed: true,
    wpPk: "wp-pk",
    createdAt: "",
    createdBy: "",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
    managed: false,
    ...overrides,
  };
}

/** Wire the in-memory store into listExternalSites + mutateExternalSites. */
function withStore(store: ExternalSiteRecord[]): void {
  listMock.mockResolvedValue(store);
  mutateMock.mockImplementation(async (mutator) => mutator(store));
}

function httpBody(payload: unknown) {
  return { status: 200, statusText: "OK", headers: {}, body: Buffer.from(JSON.stringify(payload)) };
}

beforeEach(() => jest.clearAllMocks());

describe("externalConnectorHealthCheck", () => {
  test("verified signed reply → ok + persists connectorVersion for the badge", async () => {
    const store = [externalLink()];
    withStore(store);
    // A well-formed signed response carrying the running plugin version.
    fetchMock.mockResolvedValue(
      httpBody({ envelope: { ok: true, kid: 1, result: { plugin: "1.4.0", php: "8.3.0" } }, sigs: { ed25519: "x", slhdsa: "y" } }),
    );
    verifyMock.mockReturnValue({ ok: true } as ReturnType<typeof verifySignedResponse>);

    const health = await externalConnectorHealthCheck(store[0].siteId);

    // Delivered over HTTPS to the plugin's /command endpoint, POST.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://blog.example.com/wp-json/infraweaver/v1/command");
    expect(opts).toMatchObject({ method: "POST" });

    expect(health.ok).toBe(true);
    expect(store[0].connectorVersion).toBe("1.4.0");
    expect(store[0].state).toBe("active"); // untouched
    expect(store[0].lastHealth?.ok).toBe(true);
  });

  test("tampered reply (bad signature) → quarantines the link and never trusts the version", async () => {
    const store = [externalLink({ connectorVersion: "1.4.0" })];
    withStore(store);
    // Authentic-looking transport, but the pinned-key check fails — the MITM case.
    fetchMock.mockResolvedValue(
      httpBody({ envelope: { ok: true, kid: 1, result: { plugin: "9.9.9" } }, sigs: { ed25519: "forged" } }),
    );
    verifyMock.mockReturnValue({ ok: false, reason: "bad-sig-ed25519" } as ReturnType<typeof verifySignedResponse>);

    await expect(externalConnectorHealthCheck(store[0].siteId)).rejects.toThrow(/quarantined/i);

    expect(store[0].state).toBe("quarantined");
    expect(store[0].rejections).toBe(1);
    // The spoofed "9.9.9" must NOT have overwritten the trusted version.
    expect(store[0].connectorVersion).toBe("1.4.0");
  });

  test("unsigned plugin rejection ({ok,reason}) surfaces the §12.5 reason, no quarantine", async () => {
    const store = [externalLink()];
    withStore(store);
    fetchMock.mockResolvedValue(httpBody({ ok: false, reason: "seq-rollback" }));

    const health = await externalConnectorHealthCheck(store[0].siteId);

    expect(health.ok).toBe(false);
    expect(health.rejectedReason).toBe("seq-rollback");
    expect(store[0].state).toBe("active"); // an unsigned deny is not tamper
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test("refuses a link that has not finished enrollment", async () => {
    const store = [externalLink({ fingerprintConfirmed: false })];
    withStore(store);

    await expect(externalConnectorHealthCheck(store[0].siteId)).rejects.toThrow(/not active yet/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an unreachable endpoint fails without quarantining", async () => {
    const store = [externalLink()];
    withStore(store);
    fetchMock.mockResolvedValue(null); // SSRF-blocked or DNS/connect failure

    await expect(externalConnectorHealthCheck(store[0].siteId)).rejects.toThrow(/could not reach/i);
    expect(store[0].state).toBe("active");
  });
});
