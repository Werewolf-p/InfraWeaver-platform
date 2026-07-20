/** @jest-environment node */
/**
 * Payment tiers — the declarative tier→flag table and the CONSOLE-AUTHORITATIVE
 * resolution helpers. These are the security-critical pieces: console feature
 * gating must derive from the tier stored on the console record, never from a
 * flag map a WordPress site could have influenced.
 */
import {
  DEFAULT_TIER_ID,
  TIERS,
  TIER_IDS,
  deriveEntitlementsForTier,
  getTier,
  isTierId,
  listTiers,
  resolveEntitlements,
  resolveTierId,
  siteHasEntitlement,
  type TierId,
} from "@/addons/wordpress-manager/lib/tiers";
import { ENTITLEMENT_FLAGS } from "@/addons/wordpress-manager/lib/entitlements";

describe("tier table", () => {
  test("Free is the base/default tier at rank 0", () => {
    expect(DEFAULT_TIER_ID).toBe("free");
    expect(TIERS.free.rank).toBe(0);
    expect(TIERS.free.grants).toEqual([]);
  });

  test("every paid tier grants `plus` (so the plugin's local gate unlocks)", () => {
    for (const id of TIER_IDS) {
      const tier = TIERS[id];
      if (tier.rank > 0) expect(tier.grants).toContain("plus");
    }
  });

  test("tier names align with the demo care-plan names", () => {
    expect(TIERS.care_basic.displayName).toBe("Care Basic");
    expect(TIERS.care_pro.displayName).toBe("Care Pro");
    expect(TIERS.care_ultimate.displayName).toBe("Care Ultimate");
  });

  test("ranks are strictly increasing across the ordered ids", () => {
    const ranks = TIER_IDS.map((id) => TIERS[id].rank);
    for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]).toBeGreaterThan(ranks[i - 1]);
  });
});

describe("listTiers", () => {
  test("returns every tier ascending by rank, Free first", () => {
    const ordered = listTiers();
    expect(ordered.map((t) => t.id)).toEqual(["free", "care_basic", "care_pro", "care_ultimate"]);
    expect(ordered[0].id).toBe(DEFAULT_TIER_ID);
  });
});

describe("deriveEntitlementsForTier", () => {
  test("emits an explicit true/false for EVERY known flag (wholesale replace)", () => {
    for (const id of TIER_IDS) {
      const map = deriveEntitlementsForTier(id);
      expect(Object.keys(map).sort()).toEqual([...ENTITLEMENT_FLAGS].sort());
      for (const flag of ENTITLEMENT_FLAGS) expect(typeof map[flag]).toBe("boolean");
    }
  });

  test("maps each tier to exactly the flags it grants", () => {
    expect(deriveEntitlementsForTier("free")).toEqual({
      plus: false,
      priority_support: false,
      advanced_analytics: false,
      white_label: false,
    });
    expect(deriveEntitlementsForTier("care_basic")).toEqual({
      plus: true,
      priority_support: false,
      advanced_analytics: false,
      white_label: false,
    });
    expect(deriveEntitlementsForTier("care_pro")).toEqual({
      plus: true,
      priority_support: true,
      advanced_analytics: true,
      white_label: false,
    });
    expect(deriveEntitlementsForTier("care_ultimate")).toEqual({
      plus: true,
      priority_support: true,
      advanced_analytics: true,
      white_label: true,
    });
  });

  test("moving a feature between tiers is a table edit — grants drive the map", () => {
    // getTier.grants is the single source; the derived map mirrors it exactly.
    const granted = new Set(getTier("care_pro").grants);
    const map = deriveEntitlementsForTier("care_pro");
    for (const flag of ENTITLEMENT_FLAGS) expect(map[flag]).toBe(granted.has(flag));
  });
});

describe("isTierId", () => {
  test("accepts known ids only", () => {
    expect(isTierId("care_pro")).toBe(true);
    expect(isTierId("free")).toBe(true);
    expect(isTierId("enterprise")).toBe(false);
    expect(isTierId("")).toBe(false);
    expect(isTierId(3)).toBe(false);
    expect(isTierId(undefined)).toBe(false);
  });
});

describe("resolveTierId — authoritative, from the console record only", () => {
  test("returns the assigned tier", () => {
    expect(resolveTierId({ tier: "care_ultimate" })).toBe("care_ultimate");
  });

  test("defaults to Free when unassigned, absent, or corrupt", () => {
    expect(resolveTierId(undefined)).toBe("free");
    expect(resolveTierId({})).toBe("free");
    expect(resolveTierId({ tier: "bogus" as unknown as TierId })).toBe("free");
  });
});

describe("resolveEntitlements — console gating never trusts a self-reported map", () => {
  test("derives from the assigned tier", () => {
    expect(resolveEntitlements({ tier: "care_pro" })).toEqual(deriveEntitlementsForTier("care_pro"));
  });

  test("SECURITY: a tier record ignores a divergent mirrored flag map", () => {
    // Simulate a mirror that (somehow) claims more than the tier — e.g. a stale
    // or tampered value. The tier is authoritative, so the extra flags are ignored.
    const record = {
      tier: "free" as TierId,
      entitlements: { flags: { plus: true, white_label: true } },
    };
    expect(resolveEntitlements(record)).toEqual(deriveEntitlementsForTier("free"));
    expect(siteHasEntitlement(record, "plus")).toBe(false);
    expect(siteHasEntitlement(record, "white_label")).toBe(false);
  });

  test("legacy record with a mirror but no tier falls back to the (signed) mirror", () => {
    const legacy = { entitlements: { flags: { plus: true } } };
    expect(resolveEntitlements(legacy)).toEqual({ plus: true });
    expect(siteHasEntitlement(legacy, "plus")).toBe(true);
  });

  test("empty record grants nothing", () => {
    expect(resolveEntitlements(undefined)).toEqual({});
    expect(siteHasEntitlement(undefined, "plus")).toBe(false);
  });
});

describe("revoke clears every paid flag", () => {
  test("moving a fully-entitled site to Free turns all flags off", () => {
    const before = { tier: "care_ultimate" as TierId };
    expect(siteHasEntitlement(before, "plus")).toBe(true);
    expect(siteHasEntitlement(before, "white_label")).toBe(true);

    const revoked = { tier: DEFAULT_TIER_ID };
    for (const flag of ENTITLEMENT_FLAGS) expect(siteHasEntitlement(revoked, flag)).toBe(false);
  });
});
