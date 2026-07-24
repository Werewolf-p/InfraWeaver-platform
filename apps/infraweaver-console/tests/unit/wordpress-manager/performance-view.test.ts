import { auditRowFixes, cacheVerdict, formatBytes } from "@/addons/wordpress-manager/lib/manage/performance-view";
import type { AuditRow, PageCacheStatus } from "@/addons/wordpress-manager/lib/manage/performance";

/**
 * The fusion core (US-4): a measured audit row's issues become recommendations
 * that reference OUR features with their live state, so measurement turns into a
 * one-click remedy. Plus the page-cache verdict (US-3) and byte formatting — all
 * pure, so the component stays a thin renderer over tested logic.
 */

function row(over: Partial<AuditRow> = {}): AuditRow {
  return {
    path: "/",
    count: 5,
    avg_ms: 1200,
    max_ms: 1500,
    last_ms: 1100,
    avg_q: 40,
    max_q: 60,
    max_mem: 1_000_000,
    issues: [],
    ...over,
  };
}

function status(over: Partial<PageCacheStatus> = {}): PageCacheStatus {
  return {
    enabled: true,
    dropin_present: true,
    dropin_is_ours: true,
    dropin_stale: false,
    template_version: 2,
    wp_cache_defined: true,
    wp_config_writable: true,
    entries: 10,
    total_bytes: 2048,
    ttl: 3600,
    exclusions: [],
    hits_today: 80,
    misses_today: 20,
    hits_7d: 700,
    misses_7d: 300,
    hit_rate: 80,
    hit_rate_7d: 70,
    ...over,
  };
}

describe("auditRowFixes", () => {
  test("slow page + cache OFF → offer Enable Page Cache", () => {
    const fixes = auditRowFixes(row({ issues: ["slow-server-generation"] }), { cacheEnabled: false });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].action).toBe("enable-cache");
    expect(fixes[0].label).toMatch(/enable Page Cache/i);
  });

  test("slow page + cache ON → offer Purge this URL (already cached)", () => {
    const fixes = auditRowFixes(row({ issues: ["very-slow-server-generation"] }), { cacheEnabled: true });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].action).toBe("purge-url");
    expect(fixes[0].label).toMatch(/already cached/i);
  });

  test("high query count → object-cache / db-cleanup pointer", () => {
    const fixes = auditRowFixes(row({ issues: ["high-query-count"] }), { cacheEnabled: true });
    expect(fixes).toHaveLength(1);
    expect(fixes[0].action).toBe("object-cache");
  });

  test("slow AND high-query stack both fixes, order-stable", () => {
    const fixes = auditRowFixes(row({ issues: ["slow-server-generation", "high-query-count"] }), { cacheEnabled: false });
    expect(fixes.map((f) => f.action)).toEqual(["enable-cache", "object-cache"]);
  });

  test("no issues → no fixes", () => {
    expect(auditRowFixes(row({ issues: [] }), { cacheEnabled: true })).toEqual([]);
  });
});

describe("cacheVerdict", () => {
  test("foreign drop-in is flagged as a conflict (no destructive path)", () => {
    const v = cacheVerdict(status({ dropin_is_ours: false }));
    expect(v.foreignDropin).toBe(true);
    expect(v.tone).toBe("warn");
  });

  test("cache off reads neutral", () => {
    const v = cacheVerdict(status({ enabled: false }));
    expect(v.tone).toBe("neutral");
    expect(v.label).toMatch(/off/i);
  });

  test("healthy hit-rate reads good with the percentage in the label", () => {
    const v = cacheVerdict(status({ hits_today: 90, misses_today: 10, hit_rate: 90 }));
    expect(v.tone).toBe("good");
    expect(v.hitRate).toBe(90);
    expect(v.label).toMatch(/90%/);
  });

  test("low hit-rate warns", () => {
    const v = cacheVerdict(status({ hits_today: 10, misses_today: 90, hit_rate: 10 }));
    expect(v.tone).toBe("warn");
  });

  test("enabled but no traffic today reads good without dividing by zero", () => {
    const v = cacheVerdict(status({ hits_today: 0, misses_today: 0, hit_rate: 0 }));
    expect(v.tone).toBe("good");
    expect(v.hitRate).toBe(0);
  });
});

describe("formatBytes", () => {
  test("scales units and rounds", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
  });
  test("non-finite / negative is 0 B", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});
