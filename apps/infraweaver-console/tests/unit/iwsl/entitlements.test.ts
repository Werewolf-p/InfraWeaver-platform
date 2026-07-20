/** @jest-environment node */
/**
 * Paid-feature entitlements — the console-side data model + normalization, and
 * the RPC-registry validator that must stay in lockstep with the plugin's
 * `IWSL_Entitlements::validate_params` (a divergence would sign a params object
 * the plugin then rejects as schema-fail).
 */
import {
  ENTITLEMENT_FLAGS,
  MAX_ENTITLEMENT_FLAGS,
  isEntitled,
  normalizeEntitlements,
  validateEntitlementsParams,
  type SiteEntitlements,
} from "@/addons/wordpress-manager/lib/entitlements";
import { RPC_REGISTRY } from "@/addons/wordpress-manager/lib/rpc/registry";

describe("normalizeEntitlements", () => {
  test("keeps known boolean flags", () => {
    expect(normalizeEntitlements({ plus: true })).toEqual({ plus: true });
    expect(normalizeEntitlements({ plus: false })).toEqual({ plus: false });
  });

  test("drops unknown flags (bounded to the console model)", () => {
    expect(normalizeEntitlements({ plus: true, bogus: true, pro: true })).toEqual({ plus: true });
  });

  test("drops non-boolean values", () => {
    expect(normalizeEntitlements({ plus: "yes" })).toEqual({});
    expect(normalizeEntitlements({ plus: 1 })).toEqual({});
  });

  test("non-object input yields an empty map", () => {
    expect(normalizeEntitlements(null)).toEqual({});
    expect(normalizeEntitlements(["plus"])).toEqual({});
    expect(normalizeEntitlements("plus")).toEqual({});
  });
});

describe("isEntitled", () => {
  const granted: SiteEntitlements = { flags: { plus: true } };
  const revoked: SiteEntitlements = { flags: { plus: false } };

  test("true only when the flag is exactly true", () => {
    expect(isEntitled(granted, "plus")).toBe(true);
    expect(isEntitled(revoked, "plus")).toBe(false);
    expect(isEntitled(undefined, "plus")).toBe(false);
    expect(isEntitled({ flags: {} }, "plus")).toBe(false);
  });
});

describe("validateEntitlementsParams (parity with the plugin allow-list)", () => {
  test("accepts a well-formed map and an empty (revoke-all) map", () => {
    expect(validateEntitlementsParams({ entitlements: { plus: true } })).toBe(true);
    expect(validateEntitlementsParams({ entitlements: {} })).toBe(true);
    expect(validateEntitlementsParams({ entitlements: { plus: true, pro_tier: false } })).toBe(true);
  });

  test("rejects a missing key, a stray key, and a non-object map", () => {
    expect(validateEntitlementsParams({})).toBe(false);
    expect(validateEntitlementsParams({ entitlements: { plus: true }, x: 1 })).toBe(false);
    expect(validateEntitlementsParams({ entitlements: true })).toBe(false);
  });

  test("rejects non-boolean values and malformed flag names", () => {
    expect(validateEntitlementsParams({ entitlements: { plus: 1 } })).toBe(false);
    expect(validateEntitlementsParams({ entitlements: { "bad-key": true } })).toBe(false);
    expect(validateEntitlementsParams({ entitlements: { Plus: true } })).toBe(false);
  });

  test("rejects more than MAX_ENTITLEMENT_FLAGS flags", () => {
    const map: Record<string, boolean> = {};
    for (let i = 0; i <= MAX_ENTITLEMENT_FLAGS; i += 1) map[`flag_${i}`] = true;
    expect(validateEntitlementsParams({ entitlements: map })).toBe(false);
  });
});

describe("RPC registry", () => {
  test("entitlements.set is registered as a params-carrying method", () => {
    expect(RPC_REGISTRY["entitlements.set"]).toBeDefined();
    expect(RPC_REGISTRY["entitlements.set"].hasParams).toBe(true);
    expect(RPC_REGISTRY["entitlements.set"].validate({ entitlements: { plus: true } })).toBe(true);
    expect(RPC_REGISTRY["entitlements.set"].validate({ entitlements: { plus: 1 } })).toBe(false);
  });

  test("plus is the first modelled flag", () => {
    expect(ENTITLEMENT_FLAGS).toContain("plus");
  });
});

describe("image_optimization flag (lossless on-site conversion)", () => {
  test("is a known, grantable flag", () => {
    expect(ENTITLEMENT_FLAGS).toContain("image_optimization");
  });

  test("survives normalization and validates on the wire", () => {
    expect(normalizeEntitlements({ image_optimization: true })).toEqual({ image_optimization: true });
    expect(validateEntitlementsParams({ entitlements: { image_optimization: true } })).toBe(true);
    // A downgrade pushes it explicitly false — still a valid wire map.
    expect(validateEntitlementsParams({ entitlements: { image_optimization: false } })).toBe(true);
  });
});
