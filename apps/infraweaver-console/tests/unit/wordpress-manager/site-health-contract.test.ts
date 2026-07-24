/** @jest-environment node */
// Site Health CONTRACT — the console-side allow-list + param schemas must mirror the
// connector's `IWSL_Plugin::allowed_methods()` shape validators exactly, so the two
// sides can never drift. Pure: the registry + schemas are isomorphic (no server-only,
// no transport), so this imports them directly.

import { RPC_REGISTRY, RPC_METHODS, callRpc } from "@/addons/wordpress-manager/lib/rpc/registry";
import {
  RULE_ID_RE,
  clampScanBudgetMs,
  linkScanParamsSchema,
  maintenanceSetParamsSchema,
  redirectCreateParamsSchema,
  redirectDeleteParamsSchema,
  redirectImportParamsSchema,
  redirectTogglesParamsSchema,
  SCAN_BUDGET_DEFAULT_MS,
  SCAN_BUDGET_MAX_MS,
  SCAN_BUDGET_MIN_MS,
} from "@/addons/wordpress-manager/lib/manage/site-health";

const NEW_METHODS = [
  "sitehealth.snapshot",
  "links.scan",
  "redirects.list",
  "redirects.create",
  "redirects.delete",
  "redirects.import",
  "redirects.set_toggles",
  "maintenance.set",
] as const;

describe("site-health RPC registry parity", () => {
  test("all eight methods are registered", () => {
    for (const m of NEW_METHODS) {
      expect(RPC_METHODS).toContain(m);
      expect(RPC_REGISTRY[m]).toBeDefined();
    }
  });

  test("hasParams matches the plugin (empty-param reads vs param methods)", () => {
    expect(RPC_REGISTRY["sitehealth.snapshot"].hasParams).toBe(false);
    expect(RPC_REGISTRY["redirects.list"].hasParams).toBe(false);
    expect(RPC_REGISTRY["links.scan"].hasParams).toBe(true);
    expect(RPC_REGISTRY["redirects.create"].hasParams).toBe(true);
    expect(RPC_REGISTRY["redirects.delete"].hasParams).toBe(true);
    expect(RPC_REGISTRY["redirects.import"].hasParams).toBe(true);
    expect(RPC_REGISTRY["redirects.set_toggles"].hasParams).toBe(true);
    expect(RPC_REGISTRY["maintenance.set"].hasParams).toBe(true);
  });

  test("empty-param reads reject any params", () => {
    expect(RPC_REGISTRY["sitehealth.snapshot"].validate({})).toBe(true);
    expect(RPC_REGISTRY["sitehealth.snapshot"].validate({ x: 1 })).toBe(false);
    expect(RPC_REGISTRY["redirects.list"].validate({})).toBe(true);
    expect(RPC_REGISTRY["redirects.list"].validate({ foo: true })).toBe(false);
  });

  test("callRpc refuses a method that is not allow-listed", async () => {
    const transport = jest.fn();
    // @ts-expect-error — deliberately an off-list method name
    await expect(callRpc(transport, "redirects.nuke", {})).rejects.toThrow(/not an allow-listed/);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("links.scan params", () => {
  const ok = (p: unknown) => RPC_REGISTRY["links.scan"].validate(p as Record<string, unknown>);
  test("accepts empty + integer budget, rejects non-int + extra keys", () => {
    expect(ok({})).toBe(true);
    expect(ok({ budget_ms: 10000 })).toBe(true);
    expect(ok({ budget_ms: 1.5 })).toBe(false);
    expect(ok({ budget_ms: 10000, foo: 1 })).toBe(false);
  });
});

describe("redirects.create params (shape only — gauntlet stays in the engine)", () => {
  test("accepts a well-formed rule, optionally with a match", () => {
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b", type: 301 }).success).toBe(true);
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b", type: 302, match: "prefix" }).success).toBe(true);
  });
  test("rejects missing type, bad type, unknown match, and extra keys", () => {
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b" }).success).toBe(false);
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b", type: 307 }).success).toBe(false);
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b", type: 301, match: "bogus" }).success).toBe(false);
    expect(redirectCreateParamsSchema.safeParse({ source: "/a", target: "/b", type: 301, extra: 1 }).success).toBe(false);
  });
});

describe("redirects.delete id shape", () => {
  test("only the server-derived id form passes", () => {
    expect(redirectDeleteParamsSchema.safeParse({ id: "r0123456789ab" }).success).toBe(true);
    expect(redirectDeleteParamsSchema.safeParse({ id: "R0123456789ab" }).success).toBe(false);
    expect(redirectDeleteParamsSchema.safeParse({ id: "r12" }).success).toBe(false);
    expect(redirectDeleteParamsSchema.safeParse({ id: "notanid" }).success).toBe(false);
  });
  test("RULE_ID_RE agrees with the plugin id shape", () => {
    expect(RULE_ID_RE.test("r0123456789ab")).toBe(true);
    expect(RULE_ID_RE.test("rabcdefabcdef")).toBe(true);
    expect(RULE_ID_RE.test("r0123456789abc")).toBe(false);
    expect(RULE_ID_RE.test("r0123456789aG")).toBe(false);
  });
});

describe("redirects.import bounds", () => {
  const row = { source: "/a", target: "/b", type: 301 };
  test("accepts 1..50 shaped rows, rejects empty / >50 / bad rows", () => {
    expect(redirectImportParamsSchema.safeParse({ rules: [row] }).success).toBe(true);
    expect(redirectImportParamsSchema.safeParse({ rules: [] }).success).toBe(false);
    expect(redirectImportParamsSchema.safeParse({ rules: Array.from({ length: 51 }, () => row) }).success).toBe(false);
    expect(redirectImportParamsSchema.safeParse({ rules: [{ source: "/a" }] }).success).toBe(false);
  });
});

describe("redirects.set_toggles params", () => {
  test("optional booleans only, strict keys", () => {
    expect(redirectTogglesParamsSchema.safeParse({}).success).toBe(true);
    expect(redirectTogglesParamsSchema.safeParse({ log_404: true }).success).toBe(true);
    expect(redirectTogglesParamsSchema.safeParse({ auto_slug: false, log_404: true }).success).toBe(true);
    expect(redirectTogglesParamsSchema.safeParse({ log_404: "yes" }).success).toBe(false);
    expect(redirectTogglesParamsSchema.safeParse({ nope: true }).success).toBe(false);
  });
});

describe("maintenance.set params", () => {
  test("enabled is required; extra fields are optional; strict keys; allow-list capped", () => {
    expect(maintenanceSetParamsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(maintenanceSetParamsSchema.safeParse({}).success).toBe(false);
    expect(
      maintenanceSetParamsSchema.safeParse({ enabled: true, headline: "Back soon", message: "x", retry_after: true, until: 123, allow_ips: ["1.2.3.4"] }).success,
    ).toBe(true);
    expect(maintenanceSetParamsSchema.safeParse({ enabled: true, allow_ips: Array.from({ length: 11 }, () => "1.2.3.4") }).success).toBe(false);
    expect(maintenanceSetParamsSchema.safeParse({ enabled: true, surprise: 1 }).success).toBe(false);
  });
});

describe("clampScanBudgetMs", () => {
  test("defaults, floor and ceiling", () => {
    expect(clampScanBudgetMs(undefined)).toBe(SCAN_BUDGET_DEFAULT_MS);
    expect(clampScanBudgetMs(1000)).toBe(SCAN_BUDGET_MIN_MS);
    expect(clampScanBudgetMs(999999)).toBe(SCAN_BUDGET_MAX_MS);
    expect(clampScanBudgetMs(12000)).toBe(12000);
    expect(clampScanBudgetMs(Number.NaN)).toBe(SCAN_BUDGET_DEFAULT_MS);
  });
});
