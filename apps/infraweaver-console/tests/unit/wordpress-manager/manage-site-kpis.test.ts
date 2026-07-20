/** @jest-environment node */
// Per-site Manage KPI exporter — the pure renderSiteMetrics() exposition
// formatter. Asserts numeric gauges, the info gauge carrying string facts as
// labels, null-value omission, label escaping, and a well-formed empty scrape.
import { renderSiteMetrics, type SiteKpiSample } from "@/addons/wordpress-manager/lib/manage/site-kpis";
import type { ManageOverview } from "@/addons/wordpress-manager/lib/manage/types";

function overview(overrides: Partial<ManageOverview> = {}): ManageOverview {
  return {
    site: "blog",
    wpVersion: "6.5",
    phpVersion: "8.3.6",
    coreUpdate: true,
    pendingUpdates: 3,
    pluginUpdates: 2,
    themeUpdates: 0,
    activePlugins: 7,
    totalPlugins: 9,
    dbSizeMb: 42,
    uploadsMb: 128,
    cachePlugin: "w3-total-cache",
    health: 88,
    connector: { active: true, lastRoundtripMs: 2663, lastCheckIso: null, connectorVersion: "0.4.2" },
    capabilities: {} as ManageOverview["capabilities"],
    panels: [],
    ...overrides,
  };
}

function sample(overrides: Partial<ManageOverview> = {}, at = Date.now()): SiteKpiSample {
  const ov = overview(overrides);
  return { site: ov.site, overview: ov, at };
}

/** Extract the value of a single `name{labels}` series line from the exposition. */
function seriesValue(text: string, series: string): string | undefined {
  const line = text.split("\n").find((l) => l.startsWith(series) && !l.startsWith("#"));
  return line?.slice(line.lastIndexOf(" ") + 1);
}

describe("renderSiteMetrics", () => {
  test("emits numeric KPI gauges + an info gauge for a site", () => {
    const text = renderSiteMetrics([sample()]);
    expect(text).toContain('iwsl_site_health{site="blog"} 88');
    expect(text).toContain('iwsl_site_plugins_total{site="blog"} 9');
    expect(text).toContain('iwsl_site_plugins_active{site="blog"} 7');
    expect(text).toContain('iwsl_site_plugins_update_available{site="blog"} 2');
    expect(text).toContain('iwsl_site_themes_update_available{site="blog"} 0');
    expect(text).toContain('iwsl_site_core_update_available{site="blog"} 1');
    expect(text).toContain('iwsl_site_pending_updates{site="blog"} 3');
    expect(text).toContain('iwsl_site_db_megabytes{site="blog"} 42');
    expect(text).toContain('iwsl_site_uploads_megabytes{site="blog"} 128');
    expect(text).toContain('iwsl_site_connector_up{site="blog"} 1');
    expect(text).toContain('iwsl_site_connector_roundtrip_milliseconds{site="blog"} 2663');
    expect(text).toContain('iwsl_site_info{site="blog",wp="6.5",php="8.3.6",cache_plugin="w3-total-cache"} 1');
    // Every series carries a HELP + TYPE header, and a trailing newline.
    expect(text).toContain("# HELP iwsl_site_health ");
    expect(text).toContain("# TYPE iwsl_site_health gauge");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("core_update_available is 0 when no core update is pending", () => {
    const text = renderSiteMetrics([sample({ coreUpdate: false })]);
    expect(text).toContain('iwsl_site_core_update_available{site="blog"} 0');
  });

  test("null db/uploads sizes omit their series (no NaN/null in exposition)", () => {
    const text = renderSiteMetrics([sample({ dbSizeMb: null, uploadsMb: null })]);
    expect(text).not.toContain("iwsl_site_db_megabytes{");
    expect(text).not.toContain("iwsl_site_uploads_megabytes{");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("null");
  });

  test("null wp/php/cache render as empty info labels, not the string 'null'", () => {
    const text = renderSiteMetrics([sample({ wpVersion: null, phpVersion: null, cachePlugin: null })]);
    expect(text).toContain('iwsl_site_info{site="blog",wp="",php="",cache_plugin=""} 1');
    expect(text).not.toContain('wp="null"');
  });

  test("snapshot_age_seconds reflects the sample's capture time", () => {
    const text = renderSiteMetrics([sample({}, Date.now() - 120_000)]);
    const age = Number(seriesValue(text, "iwsl_site_snapshot_age_seconds"));
    expect(age).toBeGreaterThanOrEqual(118);
    expect(age).toBeLessThanOrEqual(122);
  });

  test("label values are escaped (no exposition injection)", () => {
    const text = renderSiteMetrics([sample({ cachePlugin: 'a"b\\c' })]);
    expect(text).toContain('cache_plugin="a\\"b\\\\c"');
  });

  test("an empty fleet is still a well-formed, non-blank exposition", () => {
    const text = renderSiteMetrics([]);
    expect(seriesValue(text, "iwsl_site_snapshots")).toBe("0");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("the snapshots count reflects the number of samples", () => {
    const text = renderSiteMetrics([sample({ site: "a" }), sample({ site: "b" })]);
    expect(seriesValue(text, "iwsl_site_snapshots")).toBe("2");
  });
});
