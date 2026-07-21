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

  test("Basic is a named entry rung that grants NO paid features", () => {
    expect(TIERS.care_basic.rank).toBe(1);
    expect(TIERS.care_basic.grants).toEqual([]);
  });

  test("Pro and Ultimate grant `plus` (so the plugin's local Plus gate unlocks)", () => {
    expect(TIERS.care_pro.grants).toContain("plus");
    expect(TIERS.care_ultimate.grants).toContain("plus");
  });

  test("tier display names use the Free / Basic / Pro / Ultimate ladder", () => {
    expect(TIERS.free.displayName).toBe("Free");
    expect(TIERS.care_basic.displayName).toBe("Basic");
    expect(TIERS.care_pro.displayName).toBe("Pro");
    expect(TIERS.care_ultimate.displayName).toBe("Ultimate");
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
      image_optimization: false,
      db_optimization: false,
      email_delivery: false,
      redirect_manager: false,
      page_cache: false,
      lazy_load: false,
      duplicate_post: false,
      svg_upload: false,
      maintenance_mode: false,
      scheduled_db_cleanup: false,
      broken_link_scan: false,
      seo_audit: false,
      auto_convert: false,
      activity_log: false,
      cdn_rewrite: false,
      speed_pack: false,
      statistics: false,
      cookie_consent: false,
      seo_suite: false,
    });
    expect(deriveEntitlementsForTier("care_basic")).toEqual({
      plus: false,
      priority_support: false,
      advanced_analytics: false,
      white_label: false,
      image_optimization: false,
      db_optimization: false,
      email_delivery: false,
      redirect_manager: false,
      page_cache: false,
      lazy_load: false,
      duplicate_post: false,
      svg_upload: false,
      maintenance_mode: false,
      scheduled_db_cleanup: false,
      broken_link_scan: false,
      seo_audit: false,
      auto_convert: false,
      activity_log: false,
      cdn_rewrite: false,
      speed_pack: false,
      statistics: false,
      cookie_consent: false,
      seo_suite: false,
    });
    expect(deriveEntitlementsForTier("care_pro")).toEqual({
      plus: true,
      priority_support: true,
      advanced_analytics: true,
      white_label: false,
      image_optimization: true,
      db_optimization: true,
      email_delivery: true,
      redirect_manager: true,
      page_cache: true,
      lazy_load: true,
      duplicate_post: true,
      svg_upload: true,
      maintenance_mode: true,
      scheduled_db_cleanup: true,
      broken_link_scan: true,
      seo_audit: true,
      auto_convert: false,
      activity_log: false,
      cdn_rewrite: false,
      speed_pack: true,
      statistics: false,
      cookie_consent: false,
      seo_suite: false,
    });
    expect(deriveEntitlementsForTier("care_ultimate")).toEqual({
      plus: true,
      priority_support: true,
      advanced_analytics: true,
      white_label: true,
      image_optimization: true,
      db_optimization: true,
      email_delivery: true,
      redirect_manager: true,
      page_cache: true,
      lazy_load: true,
      duplicate_post: true,
      svg_upload: true,
      maintenance_mode: true,
      scheduled_db_cleanup: true,
      broken_link_scan: true,
      seo_audit: true,
      auto_convert: true,
      activity_log: true,
      cdn_rewrite: true,
      speed_pack: true,
      statistics: true,
      cookie_consent: true,
      seo_suite: true,
    });
  });

  test("moving a feature between tiers is a table edit — grants drive the map", () => {
    // getTier.grants is the single source; the derived map mirrors it exactly.
    const granted = new Set(getTier("care_pro").grants);
    const map = deriveEntitlementsForTier("care_pro");
    for (const flag of ENTITLEMENT_FLAGS) expect(map[flag]).toBe(granted.has(flag));
  });
});

describe("image_optimization — the lossless-conversion gate (Pro and above only)", () => {
  test("granted at Pro and inherited by Ultimate", () => {
    expect(siteHasEntitlement({ tier: "care_pro" }, "image_optimization")).toBe(true);
    expect(siteHasEntitlement({ tier: "care_ultimate" }, "image_optimization")).toBe(true);
  });

  test("STRICT: never granted to Free or Basic (the tiers below Pro)", () => {
    expect(siteHasEntitlement({ tier: "free" }, "image_optimization")).toBe(false);
    expect(siteHasEntitlement({ tier: "care_basic" }, "image_optimization")).toBe(false);
    // Explicit `false` in the wholesale-replace map — a downgrade actively
    // clears the flag on the wire rather than leaving it dangling.
    expect(deriveEntitlementsForTier("care_basic").image_optimization).toBe(false);
    expect(deriveEntitlementsForTier("free").image_optimization).toBe(false);
  });
});

describe("Pro on-site tool flags (db_optimization / email_delivery / redirect_manager)", () => {
  const proTools = ["db_optimization", "email_delivery", "redirect_manager", "page_cache"] as const;

  test("granted at Pro and inherited by Ultimate", () => {
    for (const flag of proTools) {
      expect(siteHasEntitlement({ tier: "care_pro" }, flag)).toBe(true);
      expect(siteHasEntitlement({ tier: "care_ultimate" }, flag)).toBe(true);
    }
  });

  test("STRICT: never granted to Free or Basic", () => {
    for (const flag of proTools) {
      expect(siteHasEntitlement({ tier: "free" }, flag)).toBe(false);
      expect(siteHasEntitlement({ tier: "care_basic" }, flag)).toBe(false);
    }
  });
});

describe("white_label — custom login + admin white-label (Ultimate only)", () => {
  test("granted only at Ultimate", () => {
    expect(siteHasEntitlement({ tier: "care_ultimate" }, "white_label")).toBe(true);
    expect(siteHasEntitlement({ tier: "care_pro" }, "white_label")).toBe(false);
    expect(siteHasEntitlement({ tier: "care_basic" }, "white_label")).toBe(false);
    expect(siteHasEntitlement({ tier: "free" }, "white_label")).toBe(false);
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
