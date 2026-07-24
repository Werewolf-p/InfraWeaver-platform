import {
  auditIssueLabel,
  fixFieldForIssue,
  isSeoLocked,
  seoRating,
  summarizeSeoStatus,
  type SeoStatusResponse,
} from "@/addons/wordpress-manager/lib/manage/seo";

/** A well-formed `seo.status` snapshot; override any leaf via the partials. */
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

describe("summarizeSeoStatus", () => {
  test("null snapshot is unmeasured, never an error", () => {
    const s = summarizeSeoStatus(null);
    expect(s.measured).toBe(false);
    expect(s.engine).toBeNull();
    expect(s.score).toBeNull();
    expect(s.rating).toBe("unknown");
    expect(s.topFixes).toEqual([]);
  });

  test("suite engine blends the histogram into a coverage-weighted score", () => {
    const s = summarizeSeoStatus(
      makeStatus({ suite: { unlocked: true, histogram: { good: 6, ok: 2, poor: 2, none: 0 } } }),
    );
    // (6 + 2*0.5) / 10 = 0.7 → 70
    expect(s.measured).toBe(true);
    expect(s.engine).toBe("suite");
    expect(s.score).toBe(70);
    expect(s.rating).toBe("good");
  });

  test("audit engine derives coverage from the last run when suite is locked", () => {
    const s = summarizeSeoStatus(
      makeStatus({ audit: { unlocked: true, last: { scanned: 10, with_issues: 4, issue_counts: {}, generated_at: "x" } } }),
    );
    expect(s.engine).toBe("audit");
    expect(s.score).toBe(60); // (10-4)/10
  });

  test("surfaces alt-text and keyword fixes, severity-ordered, capped at two", () => {
    const s = summarizeSeoStatus(
      makeStatus({
        suite: { unlocked: true, histogram: { good: 5, ok: 0, poor: 0, none: 0 } },
        alt: { images: 20, missing: 8 },
        keywords: { set: 2, missing: 5, duplicates: 0 },
      }),
    );
    expect(s.topFixes.length).toBe(2);
    // alt (serious) ranks before keywords (minor)
    expect(s.topFixes[0].key).toBe("alt");
  });

  test("a fully-noindexed corpus is a critical, first-ranked visibility loss", () => {
    const s = summarizeSeoStatus(
      makeStatus({
        suite: { unlocked: true, histogram: { good: 3, ok: 0, poor: 0, none: 0 } },
        schema: { site_representation: true, typed_posts: 3, published: 3 },
        noindexed: 3,
      }),
    );
    expect(s.invisible).toBe(true);
    expect(s.topFixes[0].key).toBe("invisible");
    expect(s.topFixes[0].severity).toBe("critical");
  });

  test("passes through conflicting engines", () => {
    const s = summarizeSeoStatus(makeStatus({ suite: { unlocked: true }, conflicting_engines: ["wordpress-seo/wp-seo.php"] }));
    expect(s.conflictingEngines).toEqual(["wordpress-seo/wp-seo.php"]);
  });
});

describe("seoRating", () => {
  test.each([
    [null, "unknown"],
    [70, "good"],
    [69, "warn"],
    [40, "warn"],
    [39, "critical"],
    [0, "critical"],
  ])("score %p → %p", (score, expected) => {
    expect(seoRating(score as number | null)).toBe(expected);
  });
});

describe("fixFieldForIssue / auditIssueLabel", () => {
  test("maps title/description issues to their fix field, leaves content work unfixable", () => {
    expect(fixFieldForIssue("missing-title")).toBe("title");
    expect(fixFieldForIssue("title-too-long")).toBe("title");
    expect(fixFieldForIssue("missing-meta-description")).toBe("desc");
    expect(fixFieldForIssue("thin-content")).toBeNull();
    expect(fixFieldForIssue("orphan-page")).toBeNull();
  });

  test("labels known codes and falls back to the raw code", () => {
    expect(auditIssueLabel("missing-title")).toBe("Missing title");
    expect(auditIssueLabel("totally-unknown")).toBe("totally-unknown");
  });
});

describe("isSeoLocked", () => {
  test("detects the structured locked upsell, not a plain result", () => {
    expect(isSeoLocked({ ok: false, locked: true, reason: "entitlement-locked", gate: {} })).toBe(true);
    expect(isSeoLocked({ ok: true, applied: true, field: "title", stored: "x" })).toBe(false);
    expect(isSeoLocked(null)).toBe(false);
  });
});
