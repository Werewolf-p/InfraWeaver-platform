import {
  consentTogglePayload,
  hardeningConfigToParams,
  headerRowToCheck,
  leakRowToCheck,
  mergeSecurityPosture,
  scanIsUsable,
  securityHardenParamsSchema,
  consentSetParamsSchema,
  validateHardenParams,
  type ConsentSettings,
  type HardeningConfig,
  type SecurityScanResult,
} from "@/addons/wordpress-manager/lib/manage/security-consent";
import type { SecurityData } from "@/addons/wordpress-manager/lib/manage/probes/security";

// A minimal, real-shaped wp-cli posture: two good, one critical → score 67.
function posture(): SecurityData {
  return {
    checks: [
      { id: "ssl", label: "TLS / HTTPS", state: "good", detail: "HTTPS." },
      { id: "salts", label: "Security keys & salts", state: "good", detail: "Defined." },
      { id: "core-current", label: "Core up to date", state: "critical", detail: "Update pending." },
    ],
    score: 67,
    adminCount: 1,
    counts: { good: 2, recommended: 0, critical: 1 },
  };
}

function okScan(overrides: Partial<SecurityScanResult> = {}): SecurityScanResult {
  return {
    ok: true,
    grade: "C",
    score: 70,
    headers: [
      { name: "Strict-Transport-Security", state: "missing", value_hint: "", why: "Forces HTTPS." },
      { name: "X-Content-Type-Options", state: "good", value_hint: "nosniff", why: "Stops MIME sniffing." },
    ],
    leaks: [{ name: "X-Powered-By", value_hint: "PHP/8.2", why: "Advertises the stack." }],
    detected_vendors: [{ vendor: "ga4", label: "Google Analytics", category: "statistics", count: 2 }],
    scanned_at: 1_700_000_000,
    ...overrides,
  };
}

describe("security.harden params validator (closed enum set)", () => {
  test("accepts a full, well-formed config", () => {
    expect(
      validateHardenParams({
        config: { hsts: true, nosniff: true, frame: "deny", referrer: "strict-origin", permissions: true, csp: "report-only" },
      }),
    ).toBe(true);
  });

  test("accepts revert on its own", () => {
    expect(validateHardenParams({ revert: true })).toBe(true);
  });

  test("rejects an empty command (no config, no revert)", () => {
    expect(validateHardenParams({})).toBe(false);
  });

  test("rejects a stray top-level key", () => {
    expect(validateHardenParams({ config: { hsts: true }, extra: 1 })).toBe(false);
  });

  test("rejects an arbitrary header name (foreclosing header injection)", () => {
    expect(validateHardenParams({ config: { "X-Evil": "boom" } })).toBe(false);
  });

  test("rejects a free-form / non-enum frame value", () => {
    expect(validateHardenParams({ config: { frame: "deny\r\nSet-Cookie: x=1" } })).toBe(false);
    expect(validateHardenParams({ config: { frame: "allowall" } })).toBe(false);
  });

  test("rejects the leaky unsafe-url referrer that is not in the enum", () => {
    expect(validateHardenParams({ config: { referrer: "unsafe-url" } })).toBe(false);
  });

  test("only ever allows the three CSP modes", () => {
    for (const csp of ["off", "report-only", "enforce"]) {
      expect(securityHardenParamsSchema.safeParse({ config: { csp } }).success).toBe(true);
    }
    expect(securityHardenParamsSchema.safeParse({ config: { csp: "enforce-now" } }).success).toBe(false);
  });

  test("rejects a non-boolean hsts", () => {
    expect(validateHardenParams({ config: { hsts: "yes" } })).toBe(false);
  });
});

describe("consent.setConfig params validator", () => {
  test("accepts a settings object", () => {
    expect(consentSetParamsSchema.safeParse({ settings: { enabled: true } }).success).toBe(true);
  });

  test("rejects a stray key", () => {
    expect(consentSetParamsSchema.safeParse({ settings: {}, x: 1 }).success).toBe(false);
  });

  test("rejects a non-object / array settings", () => {
    expect(consentSetParamsSchema.safeParse({ settings: [] }).success).toBe(false);
    expect(consentSetParamsSchema.safeParse({ settings: null }).success).toBe(false);
    expect(consentSetParamsSchema.safeParse({ settings: "on" }).success).toBe(false);
  });
});

describe("consentTogglePayload (default-OFF, never fabricate)", () => {
  test("flips enabled true while preserving the connector's own settings", () => {
    const current: ConsentSettings = {
      enabled: false,
      default_model: "opt-in",
      categories: { necessary: true, preferences: true, statistics: true, marketing: true },
      saved_at: 123,
    };
    const payload = consentTogglePayload(current, true);
    expect(payload.settings.enabled).toBe(true);
    expect(payload.settings.default_model).toBe("opt-in");
    expect(payload.settings.categories).toEqual(current.categories);
  });

  test("drops saved_at (the plugin stamps it)", () => {
    const payload = consentTogglePayload({ enabled: true, saved_at: 999 }, false);
    expect("saved_at" in payload.settings).toBe(false);
    expect(payload.settings.enabled).toBe(false);
  });

  test("undefined current still produces a valid enable payload (no fabrication beyond enabled)", () => {
    const payload = consentTogglePayload(undefined, true);
    expect(payload.settings).toEqual({ enabled: true });
    expect(consentSetParamsSchema.safeParse(payload).success).toBe(true);
  });
});

describe("hardeningConfigToParams (stored config → enum-only send shape)", () => {
  const full: HardeningConfig = { hsts: true, nosniff: true, frame: "sameorigin", referrer: "strict-origin", permissions: true, csp: "enforce" };

  test("keeps set frame/referrer and produces a plugin-valid params object", () => {
    const params = { config: hardeningConfigToParams(full) };
    expect(params.config.frame).toBe("sameorigin");
    expect(params.config.referrer).toBe("strict-origin");
    expect(validateHardenParams(params)).toBe(true);
  });

  test("OMITS empty frame/referrer (never sends '') so the closed-enum validator accepts it", () => {
    const off: HardeningConfig = { hsts: false, nosniff: false, frame: "", referrer: "", permissions: false, csp: "off" };
    const cfg = hardeningConfigToParams(off);
    expect("frame" in cfg).toBe(false);
    expect("referrer" in cfg).toBe(false);
    expect(cfg.csp).toBe("off");
    expect(validateHardenParams({ config: cfg })).toBe(true);
  });
});

describe("scanIsUsable", () => {
  test("true only for an ok, unlocked scan", () => {
    expect(scanIsUsable(okScan())).toBe(true);
  });
  test("false for null, locked, or a fetch failure", () => {
    expect(scanIsUsable(null)).toBe(false);
    expect(scanIsUsable({ ok: false, locked: true })).toBe(false);
    expect(scanIsUsable({ ok: false, reason: "fetch-failed" })).toBe(false);
  });
});

describe("mergeSecurityPosture", () => {
  test("posture-only when no scan (headers blind, unchanged score)", () => {
    const merged = mergeSecurityPosture(posture(), null);
    expect(merged.headerGrade).toBeNull();
    expect(merged.score).toBe(67);
    expect(merged.checks).toHaveLength(3);
    expect(merged.checks.every((c) => c.source === "wp-cli")).toBe(true);
  });

  test("appends header + leak rows and blends the score when a scan is present", () => {
    const merged = mergeSecurityPosture(posture(), okScan());
    // 3 wp-cli + 2 headers + 1 leak
    expect(merged.checks).toHaveLength(6);
    expect(merged.headerGrade).toBe("C");
    // blended: round((67 + 70) / 2) = 69
    expect(merged.score).toBe(69);
    const header = merged.checks.find((c) => c.id === "header-strict-transport-security");
    expect(header?.state).toBe("critical"); // missing → critical
    expect(header?.source).toBe("headers");
    const leak = merged.checks.find((c) => c.id === "leak-x-powered-by");
    expect(leak?.state).toBe("recommended");
  });

  test("a locked scan degrades to posture-only (no header rows)", () => {
    const merged = mergeSecurityPosture(posture(), { ok: false, locked: true, gate: { unlocked: false, tier: "care_basic" } });
    expect(merged.checks).toHaveLength(3);
    expect(merged.headerGrade).toBeNull();
    expect(merged.score).toBe(67);
  });

  test("recomputes counts across the fused list", () => {
    const merged = mergeSecurityPosture(posture(), okScan());
    // good: 2 wp-cli + 1 header good = 3; critical: 1 wp-cli + 1 header missing = 2; recommended: 1 leak
    expect(merged.counts).toEqual({ good: 3, recommended: 1, critical: 2 });
  });

  test("does not mutate the input posture", () => {
    const p = posture();
    const before = JSON.stringify(p);
    mergeSecurityPosture(p, okScan());
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("headerRowToCheck / leakRowToCheck mapping", () => {
  test("weak header → recommended", () => {
    expect(headerRowToCheck({ name: "Referrer-Policy", state: "weak", value_hint: "no-referrer-when-downgrade", why: "Leaky." }).state).toBe(
      "recommended",
    );
  });
  test("leak is always recommended and carries the value hint", () => {
    const c = leakRowToCheck({ name: "Server", value_hint: "nginx/1.25", why: "Reveals version." });
    expect(c.state).toBe("recommended");
    expect(c.detail).toContain("nginx/1.25");
  });
});
