import { parsePerformance } from "@/addons/wordpress-manager/lib/manage/probes/performance";

/**
 * US-2 — the console must recognise its OWN page cache. `parsePerformance` reads a
 * new `IWSL_PAGE_CACHE_DROPIN` scalar (signature match on advanced-cache.php) and
 * must (a) rank our drop-in first as `pageCache: "iwsl"`, and (b) STOP recommending
 * competitor plugins while our cache is live — the embarrassing bug this fixes.
 */

/** Build the scalar block the probe parses, with sensible healthy defaults. */
function scalars(over: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    OBJECT_CACHE_DROPIN: "absent",
    IWSL_PAGE_CACHE_DROPIN: "absent",
    CACHE_TYPE: "Default",
    PHP_VERSION: "8.3.0",
    MEMORY_LIMIT: "512M",
    TRANSIENTS: "10",
    ...over,
  };
  return Object.entries(base)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

describe("parsePerformance — IWSL drop-in detection (US-2)", () => {
  test("our drop-in present → pageCache 'iwsl' and iwslPageCache true", () => {
    const data = parsePerformance({ scalars: scalars({ IWSL_PAGE_CACHE_DROPIN: "present" }), plugins: "[]", autoloadKb: "100" });
    expect(data.iwslPageCache).toBe(true);
    expect(data.pageCache).toBe("iwsl");
  });

  test("our cache live → NO competitor recommendation (the bug)", () => {
    const data = parsePerformance({ scalars: scalars({ IWSL_PAGE_CACHE_DROPIN: "present" }), plugins: "[]", autoloadKb: "100" });
    const joined = data.recommendations.join(" ");
    expect(joined).not.toMatch(/WP Rocket|W3 Total Cache|LiteSpeed/i);
    expect(joined).not.toMatch(/no page cache/i);
  });

  test("no cache at all → a page-cache nudge that never names a competitor", () => {
    const data = parsePerformance({ scalars: scalars(), plugins: "[]", autoloadKb: "100" });
    expect(data.pageCache).toBeNull();
    const joined = data.recommendations.join(" ");
    expect(joined).toMatch(/page cache/i);
    expect(joined).not.toMatch(/WP Rocket|W3 Total Cache|LiteSpeed/i);
  });

  test("third-party plugin active (no IWSL) → detected by slug, no nudge", () => {
    const data = parsePerformance({ scalars: scalars(), plugins: JSON.stringify(["wp-rocket"]), autoloadKb: "100" });
    expect(data.pageCache).toBe("wp-rocket");
    expect(data.pageCachePlugin).toBe("wp-rocket");
    expect(data.recommendations.join(" ")).not.toMatch(/no page cache/i);
  });

  test("our drop-in ranks FIRST over a third-party plugin (conflict still surfaced)", () => {
    const data = parsePerformance({
      scalars: scalars({ IWSL_PAGE_CACHE_DROPIN: "present" }),
      plugins: JSON.stringify(["wp-rocket"]),
      autoloadKb: "100",
    });
    expect(data.pageCache).toBe("iwsl");
    // The third-party slug stays available for the panel's conflict note.
    expect(data.pageCachePlugin).toBe("wp-rocket");
  });

  test("object-cache + autoload signals still work alongside the new field", () => {
    const data = parsePerformance({
      scalars: scalars({ OBJECT_CACHE_DROPIN: "present", CACHE_TYPE: "Redis" }),
      plugins: "[]",
      autoloadKb: "1200",
    });
    expect(data.persistentObjectCache).toBe(true);
    expect(data.autoloadKb).toBe(1200);
    expect(data.recommendations.join(" ")).toMatch(/Autoloaded options weigh 1200 KB/);
  });
});
