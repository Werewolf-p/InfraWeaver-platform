import { RPC_REGISTRY, RPC_METHODS } from "@/addons/wordpress-manager/lib/rpc/registry";

const SECURITY_METHODS = [
  "security.scan",
  "security.harden",
  "consent.getConfig",
  "consent.setConfig",
  "protection.status",
] as const;

describe("RPC registry — Site Security methods", () => {
  test("all five signed methods are allow-listed", () => {
    for (const m of SECURITY_METHODS) {
      expect(RPC_METHODS).toContain(m);
      expect(RPC_REGISTRY[m]).toBeDefined();
    }
  });

  test("the read trio takes no params", () => {
    for (const m of ["security.scan", "consent.getConfig", "protection.status"] as const) {
      expect(RPC_REGISTRY[m].hasParams).toBe(false);
      expect(RPC_REGISTRY[m].validate({})).toBe(true);
      expect(RPC_REGISTRY[m].validate({ x: 1 })).toBe(false);
    }
  });

  test("security.harden validator is the closed key/enum set (parity with the plugin)", () => {
    const v = RPC_REGISTRY["security.harden"];
    expect(v.hasParams).toBe(true);
    expect(v.validate({ config: { csp: "report-only" } })).toBe(true);
    expect(v.validate({ revert: true })).toBe(true);
    // free-form header name / value + empty command are refused
    expect(v.validate({ config: { "X-Evil": "x" } })).toBe(false);
    expect(v.validate({ config: { csp: "enforce-now" } })).toBe(false);
    expect(v.validate({})).toBe(false);
  });

  test("consent.setConfig validator requires exactly one settings object key", () => {
    const v = RPC_REGISTRY["consent.setConfig"];
    expect(v.hasParams).toBe(true);
    expect(v.validate({ settings: { enabled: true } })).toBe(true);
    expect(v.validate({ settings: [] })).toBe(false);
    expect(v.validate({ settings: {}, extra: 1 })).toBe(false);
    expect(v.validate({})).toBe(false);
  });
});
