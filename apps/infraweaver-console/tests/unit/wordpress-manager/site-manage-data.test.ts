import { getSiteManageData, siteSeed } from "@/addons/wordpress-manager/components/demo/site-manage-data";

describe("site-manage-data (demo generator)", () => {
  test("siteSeed is a stable 32-bit unsigned integer", () => {
    const seed = siteSeed("hi2");
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
    expect(siteSeed("hi2")).toBe(seed);
    expect(siteSeed("hi2")).not.toBe(siteSeed("hi3"));
  });

  test("is deterministic — same site name yields deep-equal data (SSR safe)", () => {
    const a = getSiteManageData("aurora-blog");
    const b = getSiteManageData("aurora-blog");
    // Memoised → identical reference, and structurally equal regardless.
    expect(a).toBe(b);
    expect(getSiteManageData("northwind-store")).toEqual(getSiteManageData("northwind-store"));
  });

  test("different sites produce different data", () => {
    const a = getSiteManageData("site-alpha");
    const b = getSiteManageData("site-beta");
    // At least one salient dimension differs; guards against a constant fixture.
    const differs =
      a.health !== b.health ||
      a.plugins.length !== b.plugins.length ||
      a.pagespeed.mobile !== b.pagespeed.mobile ||
      a.core.php !== b.core.php;
    expect(differs).toBe(true);
  });

  test("all numeric fields are finite and in range (no NaN/hydration drift)", () => {
    for (const site of ["hi2", "aurora-blog", "verdant-cms", "x", "a-very-long-site-name-123"]) {
      const d = getSiteManageData(site);
      expect(d.health).toBeGreaterThanOrEqual(0);
      expect(d.health).toBeLessThanOrEqual(100);
      expect(d.pagespeed.mobile).toBeGreaterThanOrEqual(0);
      expect(d.pagespeed.mobile).toBeLessThanOrEqual(100);
      expect(d.pagespeed.desktop).toBeLessThanOrEqual(100);

      expect(d.plugins.length).toBeGreaterThan(0);
      expect(d.themes.filter((t) => t.active).length).toBe(1); // exactly one active theme
      expect(d.users.filter((u) => u.role === "administrator").length).toBeGreaterThan(0);

      const numbers = [
        d.dbTotalMb,
        d.dbOverheadMb,
        d.ssl.expiresDays,
        d.seo.score,
        ...d.trafficTrend.map((p) => p.visitors),
        ...d.wafTrend.map((p) => p.blocked),
        ...d.responseTrend.map((p) => p.ms),
        ...d.storage.map((s) => s.gb),
      ];
      for (const n of numbers) {
        expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  test("composite health reflects security pressure", () => {
    // A site with a security-flagged plugin or malware hit should never score 100.
    for (const site of ["hi2", "aurora-blog", "meridian", "northwind", "cobalt", "verdant"]) {
      const d = getSiteManageData(site);
      const securityPressure = d.plugins.filter((p) => p.updateType === "security").length + d.malware.flagged;
      if (securityPressure > 0) {
        expect(d.health).toBeLessThan(100);
      }
    }
  });
});
