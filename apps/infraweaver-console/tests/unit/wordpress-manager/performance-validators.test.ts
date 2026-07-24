import {
  cacheConfigureParamsSchema,
  cachePurgeParamsSchema,
  cacheWarmParamsSchema,
  perfAuditParamsSchema,
  perfSettingsParamsSchema,
  PERF_READ_VERBS,
  PERF_WRITE_VERBS,
} from "@/addons/wordpress-manager/lib/manage/performance";
import { RPC_REGISTRY, RPC_METHODS } from "@/addons/wordpress-manager/lib/rpc/registry";

/**
 * The console-side param validators must MIRROR the connector's closures exactly
 * (the `$perf_audit_params` … `$perf_settings_params` in class-iwsl-plugin.php): a
 * request the console accepts is one the plugin's validator also accepts, so a
 * signed command can never be shaped by the console that the plugin then rejects.
 */

describe("perf.audit params", () => {
  test("empty params are valid (rows optional)", () => {
    expect(perfAuditParamsSchema.safeParse({}).success).toBe(true);
  });
  test("rows within 1..25 accepted, out-of-range refused", () => {
    expect(perfAuditParamsSchema.safeParse({ rows: 25 }).success).toBe(true);
    expect(perfAuditParamsSchema.safeParse({ rows: 1 }).success).toBe(true);
    expect(perfAuditParamsSchema.safeParse({ rows: 26 }).success).toBe(false);
    expect(perfAuditParamsSchema.safeParse({ rows: 0 }).success).toBe(false);
  });
  test("stray keys are refused (parity with array_diff_key)", () => {
    expect(perfAuditParamsSchema.safeParse({ rows: 5, extra: 1 }).success).toBe(false);
  });
});

describe("cache.purge params", () => {
  test("scope:all with no other key is valid", () => {
    expect(cachePurgeParamsSchema.safeParse({ scope: "all" }).success).toBe(true);
  });
  test("scope:all with paths is refused (strict)", () => {
    expect(cachePurgeParamsSchema.safeParse({ scope: "all", paths: ["/x"] }).success).toBe(false);
  });
  test("scope:paths needs 1..50 non-empty paths", () => {
    expect(cachePurgeParamsSchema.safeParse({ scope: "paths", paths: ["/a", "/b"] }).success).toBe(true);
    expect(cachePurgeParamsSchema.safeParse({ scope: "paths", paths: [] }).success).toBe(false);
    expect(cachePurgeParamsSchema.safeParse({ scope: "paths", paths: [""] }).success).toBe(false);
    expect(cachePurgeParamsSchema.safeParse({ scope: "paths" }).success).toBe(false);
    const tooMany = Array.from({ length: 51 }, (_, i) => `/p${i}`);
    expect(cachePurgeParamsSchema.safeParse({ scope: "paths", paths: tooMany }).success).toBe(false);
  });
  test("unknown scope is refused", () => {
    expect(cachePurgeParamsSchema.safeParse({ scope: "everything" }).success).toBe(false);
  });
});

describe("cache.warm params", () => {
  test("empty params are valid (warm the audit-fed default set)", () => {
    expect(cacheWarmParamsSchema.safeParse({}).success).toBe(true);
  });
  test("limit within 1..25 accepted, past cap refused", () => {
    expect(cacheWarmParamsSchema.safeParse({ limit: 25 }).success).toBe(true);
    expect(cacheWarmParamsSchema.safeParse({ limit: 26 }).success).toBe(false);
  });
  test("paths within 1..25 accepted, empty list refused, strays refused", () => {
    expect(cacheWarmParamsSchema.safeParse({ paths: ["/a"] }).success).toBe(true);
    expect(cacheWarmParamsSchema.safeParse({ paths: [] }).success).toBe(false);
    expect(cacheWarmParamsSchema.safeParse({ paths: ["/a"], nope: 1 }).success).toBe(false);
  });
});

describe("cache.configure params", () => {
  test("requires at least one of enabled/ttl/exclusions (empty refused)", () => {
    expect(cacheConfigureParamsSchema.safeParse({}).success).toBe(false);
    expect(cacheConfigureParamsSchema.safeParse({ enabled: true }).success).toBe(true);
  });
  test("ttl clamped to 600..86400", () => {
    expect(cacheConfigureParamsSchema.safeParse({ ttl: 600 }).success).toBe(true);
    expect(cacheConfigureParamsSchema.safeParse({ ttl: 86400 }).success).toBe(true);
    expect(cacheConfigureParamsSchema.safeParse({ ttl: 599 }).success).toBe(false);
    expect(cacheConfigureParamsSchema.safeParse({ ttl: 86401 }).success).toBe(false);
  });
  test("exclusions capped at 50 patterns", () => {
    expect(cacheConfigureParamsSchema.safeParse({ exclusions: ["/x", "/y/*"] }).success).toBe(true);
    const tooMany = Array.from({ length: 51 }, (_, i) => `/p${i}`);
    expect(cacheConfigureParamsSchema.safeParse({ exclusions: tooMany }).success).toBe(false);
  });
  test("stray keys refused", () => {
    expect(cacheConfigureParamsSchema.safeParse({ enabled: true, ttl: 700, junk: 1 }).success).toBe(false);
  });
});

describe("perf.settings.set params", () => {
  test("requires lazy_load and/or speed_pack (empty refused)", () => {
    expect(perfSettingsParamsSchema.safeParse({}).success).toBe(false);
    expect(perfSettingsParamsSchema.safeParse({ lazy_load: {} }).success).toBe(true);
    expect(perfSettingsParamsSchema.safeParse({ speed_pack: { minify_html: true } }).success).toBe(true);
  });
  test("only the connector's allow-listed speed-pack keys are accepted", () => {
    expect(perfSettingsParamsSchema.safeParse({ speed_pack: { defer_js: true, delay_js: false } }).success).toBe(true);
    expect(perfSettingsParamsSchema.safeParse({ speed_pack: { not_a_switch: true } }).success).toBe(false);
  });
  test("lazy_load skip_images clamped to 0..20 and keys allow-listed", () => {
    expect(perfSettingsParamsSchema.safeParse({ lazy_load: { skip_images: 20 } }).success).toBe(true);
    expect(perfSettingsParamsSchema.safeParse({ lazy_load: { skip_images: 21 } }).success).toBe(false);
    expect(perfSettingsParamsSchema.safeParse({ lazy_load: { bogus: true } }).success).toBe(false);
  });
});

describe("RPC registry wiring", () => {
  const methods = ["perf.status", "perf.audit", "cache.purge", "cache.warm", "cache.configure", "perf.settings.set"] as const;

  test("every performance method is registered and allow-listed", () => {
    for (const m of methods) {
      expect(RPC_REGISTRY[m]).toBeDefined();
      expect(RPC_METHODS).toContain(m);
    }
  });
  test("perf.status carries no params; the rest carry params", () => {
    expect(RPC_REGISTRY["perf.status"].hasParams).toBe(false);
    expect(RPC_REGISTRY["perf.status"].validate({})).toBe(true);
    expect(RPC_REGISTRY["perf.status"].validate({ x: 1 })).toBe(false);
    for (const m of ["perf.audit", "cache.purge", "cache.warm", "cache.configure", "perf.settings.set"] as const) {
      expect(RPC_REGISTRY[m].hasParams).toBe(true);
    }
  });
  test("registry validators delegate to the zod schemas (cache.purge sample)", () => {
    expect(RPC_REGISTRY["cache.purge"].validate({ scope: "all" })).toBe(true);
    expect(RPC_REGISTRY["cache.purge"].validate({ scope: "bogus" })).toBe(false);
  });
});

describe("verb vocabularies", () => {
  test("read + write verbs are the expected sets", () => {
    expect([...PERF_READ_VERBS]).toEqual(["status", "audit"]);
    expect([...PERF_WRITE_VERBS]).toEqual(["purge", "warm", "configure", "settings"]);
  });
});
