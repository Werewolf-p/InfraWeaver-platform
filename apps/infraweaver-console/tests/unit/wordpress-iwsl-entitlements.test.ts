/** @jest-environment node */
// setSiteEntitlements — the console → plugin direction of the paid-feature state.
// The contract that matters: the flag map is normalized, PUSHED over the signed
// command channel (`entitlements.set`), and only mirrored into the registry AFTER
// the plugin accepts. A plugin rejection must NOT leave the console claiming a
// grant the site doesn't have.
jest.mock("server-only", () => ({}), { virtual: true });

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

import { setSiteEntitlements, setSiteTier } from "@/addons/wordpress-manager/lib/iwsl-managed-ops";
import { deriveEntitlementsForTier } from "@/addons/wordpress-manager/lib/tiers";
import { listExternalSites, mutateExternalSites, type ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";
import { execInWpPod } from "@/addons/wordpress-manager/lib/k8s-exec";
import { findWpPodName } from "@/addons/wordpress-manager/lib/provision";
import { createSignedCommand, verifySignedResponse } from "@/lib/iwsl";

const listMock = listExternalSites as jest.MockedFunction<typeof listExternalSites>;
const mutateMock = mutateExternalSites as jest.MockedFunction<typeof mutateExternalSites>;
const execMock = execInWpPod as jest.MockedFunction<typeof execInWpPod>;
const findPodMock = findWpPodName as jest.MockedFunction<typeof findWpPodName>;
const signMock = createSignedCommand as jest.MockedFunction<typeof createSignedCommand>;
const verifyMock = verifySignedResponse as jest.MockedFunction<typeof verifySignedResponse>;

function managedLink(overrides: Partial<ExternalSiteRecord> = {}): ExternalSiteRecord {
  return {
    siteId: "22222222-2222-2222-2222-222222222222",
    name: "Managed blog",
    url: "https://blog.internal",
    state: "active",
    fingerprintConfirmed: true,
    wpPk: "wp-pk",
    createdAt: "",
    createdBy: "",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
    managed: true,
    siteName: "blog",
    ...overrides,
  };
}

function withStore(store: ExternalSiteRecord[]): void {
  listMock.mockResolvedValue(store);
  mutateMock.mockImplementation(async (mutator) => mutator(store));
}

/** A signed reply the plugin returns for a verified entitlements.set. */
function signedReply(result: unknown) {
  return { stdout: JSON.stringify({ status: 200, body: { envelope: { ok: true, kid: 1, result }, sigs: { ed25519: "x" } } }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  findPodMock.mockResolvedValue("wp-pod-1");
});

describe("setSiteEntitlements", () => {
  test("pushes over the signed channel, then mirrors into the registry", async () => {
    const store = [managedLink()];
    withStore(store);
    execMock.mockResolvedValue(signedReply({ entitlements: { plus: true } }) as never);
    verifyMock.mockReturnValue({ ok: true } as ReturnType<typeof verifySignedResponse>);

    const result = await setSiteEntitlements("blog", { plus: true }, "alice");

    // Signed command was the transport, and it carried the entitlements.set method.
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(signMock).toHaveBeenCalledTimes(1);
    const signInput = signMock.mock.calls[0][0];
    expect(signInput.method).toBe("entitlements.set");
    expect(signInput.params).toEqual({ entitlements: { plus: true } });

    // Registry mirror written with the audit trail.
    expect(result.flags).toEqual({ plus: true });
    expect(result.updatedBy).toBe("alice");
    expect(store[0].entitlements).toEqual({ flags: { plus: true }, updatedAt: result.updatedAt, updatedBy: "alice" });
  });

  test("normalizes away unknown flags before signing", async () => {
    const store = [managedLink()];
    withStore(store);
    execMock.mockResolvedValue(signedReply({ entitlements: { plus: true } }) as never);
    verifyMock.mockReturnValue({ ok: true } as ReturnType<typeof verifySignedResponse>);

    await setSiteEntitlements("blog", { plus: true, bogus: true } as Record<string, boolean>, "alice");

    // The out-of-model `bogus` flag never reaches the wire.
    expect(signMock.mock.calls[0][0].params).toEqual({ entitlements: { plus: true } });
    expect(store[0].entitlements?.flags).toEqual({ plus: true });
  });

  test("a plugin rejection throws and does NOT persist a phantom grant", async () => {
    const store = [managedLink()];
    withStore(store);
    // Unsigned rejection ({ok,reason}) — no envelope.
    execMock.mockResolvedValue({ stdout: JSON.stringify({ status: 403, body: { ok: false, reason: "unknown-method" } }) } as never);

    await expect(setSiteEntitlements("blog", { plus: true }, "alice")).rejects.toThrow(/rejected/i);

    expect(execMock).toHaveBeenCalledTimes(1); // the push was attempted
    expect(store[0].entitlements).toBeUndefined(); // but the registry was NOT written
    expect(verifyMock).not.toHaveBeenCalled();
  });

  test("refuses a link that has not finished enrollment (no signed send)", async () => {
    const store = [managedLink({ fingerprintConfirmed: false })];
    withStore(store);

    await expect(setSiteEntitlements("blog", { plus: true }, "alice")).rejects.toThrow(/not active yet/i);
    expect(execMock).not.toHaveBeenCalled();
    expect(store[0].entitlements).toBeUndefined();
  });

  test("refuses while the link is in identity safe mode", async () => {
    const store = [managedLink({ identitySuspended: true })];
    withStore(store);

    await expect(setSiteEntitlements("blog", { plus: true }, "alice")).rejects.toThrow(/identity safe mode/i);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("setSiteTier", () => {
  test("derives the tier's flag map, pushes it, and mirrors BOTH tier and flags", async () => {
    const store = [managedLink()];
    withStore(store);
    const expectedFlags = deriveEntitlementsForTier("care_pro");
    execMock.mockResolvedValue(signedReply({ entitlements: expectedFlags }) as never);
    verifyMock.mockReturnValue({ ok: true } as ReturnType<typeof verifySignedResponse>);

    const result = await setSiteTier("blog", "care_pro", "alice");

    // The signed push carried the FULL derived map for the tier.
    expect(signMock.mock.calls[0][0].method).toBe("entitlements.set");
    expect(signMock.mock.calls[0][0].params).toEqual({ entitlements: expectedFlags });

    // The record mirrors both the authoritative tier and the flag map.
    expect(result.tier).toBe("care_pro");
    expect(result.flags).toEqual(expectedFlags);
    expect(store[0].tier).toBe("care_pro");
    expect(store[0].entitlements?.flags).toEqual(expectedFlags);
  });

  test("revoke (Free tier) pushes an all-off map and stores tier=free", async () => {
    const store = [managedLink({ tier: "care_ultimate" })];
    withStore(store);
    const freeFlags = deriveEntitlementsForTier("free");
    execMock.mockResolvedValue(signedReply({ entitlements: freeFlags }) as never);
    verifyMock.mockReturnValue({ ok: true } as ReturnType<typeof verifySignedResponse>);

    const result = await setSiteTier("blog", "free", "alice");

    // Every paid flag is explicitly false on the wire (wholesale replace clears the site).
    expect(signMock.mock.calls[0][0].params).toEqual({ entitlements: freeFlags });
    expect(Object.values(freeFlags).every((v) => v === false)).toBe(true);
    expect(result.tier).toBe("free");
    expect(store[0].tier).toBe("free");
  });

  test("a plugin rejection leaves the stored tier untouched (no phantom upgrade)", async () => {
    const store = [managedLink({ tier: "free" })];
    withStore(store);
    execMock.mockResolvedValue({ stdout: JSON.stringify({ status: 403, body: { ok: false, reason: "unknown-method" } }) } as never);

    await expect(setSiteTier("blog", "care_ultimate", "alice")).rejects.toThrow(/rejected/i);

    expect(store[0].tier).toBe("free"); // unchanged
    expect(store[0].entitlements).toBeUndefined();
  });
});
