import { parseAudit, type ParseAuditInput } from "@/addons/wordpress-manager/lib/manage/probes/audit-core";
import type { SeoStatusResponse } from "@/addons/wordpress-manager/lib/manage/seo";

function makeStatus(over: Partial<{
  suite: Partial<SeoStatusResponse["engines"]["suite"]>;
  audit: Partial<SeoStatusResponse["engines"]["audit"]>;
  alt: Partial<SeoStatusResponse["alt"]>;
  keywords: Partial<SeoStatusResponse["keywords"]>;
  schema: SeoStatusResponse["schema"];
  noindexed: number;
  conflicting_engines: string[];
}> = {}): SeoStatusResponse {
  return {
    ok: true,
    engines: {
      suite: {
        unlocked: false,
        switched_off: false,
        score_avg: null,
        histogram: { good: 0, ok: 0, poor: 0, none: 0 },
        sitemap: { active: false, url: null },
        robots_managed: false,
        ...over.suite,
      },
      audit: { unlocked: false, switched_off: false, last: null, ...over.audit },
    },
    alt: { images: 0, missing: 0, ...over.alt },
    keywords: { set: 0, missing: 0, duplicates: 0, ...over.keywords },
    schema: over.schema ?? null,
    four04: null,
    noindexed: over.noindexed ?? 0,
    conflicting_engines: over.conflicting_engines ?? [],
  };
}

const BASE: ParseAuditInput = {
  status: null,
  connectorTooOld: false,
  activePlugins: "[]",
  publishedPosts: "10",
  imageAttachments: "0",
  imagesMissingAlt: "0",
  missingMetadesc: "0",
  missingFocusKw: "0",
  titles: "",
};

describe("parseAudit — engine awareness", () => {
  test("SEO Suite site is measured by the suite, NOT told to activate Yoast", () => {
    const data = parseAudit({
      ...BASE,
      status: makeStatus({
        suite: { unlocked: true, histogram: { good: 8, ok: 0, poor: 2, none: 0 } },
        alt: { images: 20, missing: 5 },
      }),
    });
    expect(data.engine).toBe("suite");
    expect(data.engineName).toBe("SEO Suite");
    expect(data.seoScore).toBe(80); // 8/10 good
    // alt coverage comes from the signed snapshot, not the SQL fallback
    expect(data.imageAttachments).toBe(20);
    expect(data.imagesMissingAlt).toBe(5);
  });

  test("Pro Meta Audit engine measures coverage from the last audit", () => {
    const data = parseAudit({
      ...BASE,
      status: makeStatus({
        audit: { unlocked: true, last: { scanned: 10, with_issues: 2, issue_counts: { "missing-meta-description": 2 }, generated_at: "t" } },
      }),
    });
    expect(data.engine).toBe("audit");
    expect(data.seoScore).toBe(80);
    expect(data.findings.some((f) => f.id === "meta-desc")).toBe(true);
  });

  test("Yoast site with no platform engine still measured via the SQL fallback", () => {
    const data = parseAudit({
      ...BASE,
      activePlugins: '["wordpress-seo"]',
      publishedPosts: "10",
      imageAttachments: "20",
      imagesMissingAlt: "0",
      missingMetadesc: "2",
      missingFocusKw: "4",
      titles: "{}",
    });
    expect(data.engine).toBe("yoast");
    expect(data.engineName).toBe("Yoast SEO");
    // 0.8*0.4 + 0.6*0.4 + 1*0.2 = 0.76 → 76
    expect(data.seoScore).toBe(76);
  });

  test("no engine at all yields a null SEO score and a11y-only overall", () => {
    const data = parseAudit({ ...BASE, imageAttachments: "10", imagesMissingAlt: "1" });
    expect(data.engine).toBeNull();
    expect(data.engineName).toBe("No SEO engine");
    expect(data.seoScore).toBeNull();
    expect(data.score).toBe(data.a11yScore);
  });

  test("two-engine conflict becomes a serious finding (A6)", () => {
    const data = parseAudit({
      ...BASE,
      status: makeStatus({ suite: { unlocked: true }, conflicting_engines: ["wordpress-seo/wp-seo.php"] }),
    });
    expect(data.findings.some((f) => f.id === "engine-conflict" && f.severity === "serious")).toBe(true);
  });

  test("fully-noindexed corpus becomes a critical visibility finding (A4)", () => {
    const data = parseAudit({
      ...BASE,
      status: makeStatus({
        suite: { unlocked: true, histogram: { good: 3, ok: 0, poor: 0, none: 0 } },
        schema: { site_representation: true, typed_posts: 3, published: 3 },
        noindexed: 3,
      }),
    });
    expect(data.findings.some((f) => f.id === "invisible" && f.severity === "critical")).toBe(true);
  });

  test("an old connector degrades gracefully (connectorTooOld passes through)", () => {
    const data = parseAudit({ ...BASE, connectorTooOld: true, activePlugins: '["wordpress-seo"]', missingMetadesc: "1", titles: "{}" });
    expect(data.connectorTooOld).toBe(true);
    // still measured via the third-party fallback, never blank
    expect(data.engine).toBe("yoast");
  });
});
