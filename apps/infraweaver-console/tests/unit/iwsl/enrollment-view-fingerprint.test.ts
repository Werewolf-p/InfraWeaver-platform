/** @jest-environment node */
// §5 / § dual-accept — the link view must render the IW-PK fingerprint of the
// SLH-DSA set THAT link pinned at enrollment, not the console's default (192s)
// set. A 192f-migrated link showing the stale 192s fingerprint would break the
// operator's by-eye §5 step-3 comparison against the plugin. (Cosmetic in that
// dispatch already signs with record.iwAlg; this fixes only the displayed fp.)

jest.mock("server-only", () => ({}), { virtual: true });

import {
  ALG_SLHDSA,
  ALG_SLHDSA_192F,
  generateIwKeyPair,
  iwKeysFingerprint,
  iwPublicKeys,
  type IwKeyPair,
} from "@/lib/iwsl";
import type { ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";

// Deterministic keypair — fixed seeds so the expected fingerprints are stable.
const keys: IwKeyPair = generateIwKeyPair({
  ed25519: new Uint8Array(32).fill(7),
  slhdsa: new Uint8Array(72).fill(11),
  slhdsa192f: new Uint8Array(72).fill(13),
});

const listExternalSites = jest.fn<Promise<ExternalSiteRecord[]>, []>();

jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: () => listExternalSites(),
  mutateExternalSites: jest.fn(),
  getExternalSite: jest.fn(),
  getEnrollSecret: jest.fn(),
  putEnrollSecret: jest.fn(),
  deleteEnrollSecret: jest.fn(),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-keys", () => ({
  loadOrCreateIwKeys: async () => ({ keys, kid: 0 }),
}));

import { listExternalSiteViews } from "@/addons/wordpress-manager/lib/iwsl-enrollment";

const fp192s = iwKeysFingerprint(iwPublicKeys(keys, ALG_SLHDSA));
const fp192f = iwKeysFingerprint(iwPublicKeys(keys, ALG_SLHDSA_192F));

function record(over: Partial<ExternalSiteRecord>): ExternalSiteRecord {
  return {
    siteId: `id-${over.iwAlg ?? "legacy"}`,
    name: "site",
    url: "https://example.test",
    state: "active",
    fingerprintConfirmed: true,
    createdAt: "2026-07-18T00:00:00.000Z",
    createdBy: "tester",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
    ...over,
  };
}

describe("listExternalSiteViews — per-link IW fingerprint (§ dual-accept)", () => {
  beforeEach(() => listExternalSites.mockReset());

  test("the 192s and 192f sets fingerprint differently", () => {
    expect(fp192f).not.toBe(fp192s);
  });

  test("a 192f-pinned link renders its 192f fingerprint, not the 192s default", async () => {
    listExternalSites.mockResolvedValue([record({ iwAlg: ALG_SLHDSA_192F })]);
    const [view] = await listExternalSiteViews();
    expect(view.iwFingerprint).toBe(fp192f);
  });

  test("a 192s-pinned link renders the 192s fingerprint", async () => {
    listExternalSites.mockResolvedValue([record({ iwAlg: ALG_SLHDSA })]);
    const [view] = await listExternalSiteViews();
    expect(view.iwFingerprint).toBe(fp192s);
  });

  test("a legacy link with no pinned alg falls back to the 192s fingerprint", async () => {
    listExternalSites.mockResolvedValue([record({ iwAlg: undefined })]);
    const [view] = await listExternalSiteViews();
    expect(view.iwFingerprint).toBe(fp192s);
  });
});
