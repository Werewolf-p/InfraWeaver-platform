/**
 * Traffic & SEO panel probe — on-page SEO coverage read live over `wp-cli`, plus
 * an honest account of the analytics posture. There is deliberately NO visitor
 * traffic here: real traffic needs an external analytics provider's API, which the
 * read-only in-pod channel cannot reach, so we never fabricate visit numbers. What
 * we CAN compute for a Yoast site — from guarded `wp db query` aggregates against
 * the real table prefix — is meta-description and focus-keyphrase coverage across
 * indexable posts and whether the XML sitemap is enabled. For a non-Yoast SEO
 * plugin the meta keys differ, so coverage is left null rather than reported as 0%.
 * Gated on the `audience` capability. Read-only: no allow-listed mutation exists,
 * so the panel renders no action buttons.
 */
import { WP, WP_SAFE, toInt, parseJsonObject } from "../wp-probe";
import { SEO_PLUGIN_SLUGS, ANALYTICS_PLUGIN_SLUGS } from "../capabilities";
import { parseJsonArray, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export interface AudienceSeo {
  /** Detected SEO plugin label, or null when none recognised. */
  readonly plugin: string | null;
  /** True when the detected SEO plugin is Yoast (the only one these meta keys apply to). */
  readonly yoast: boolean;
  /** Published (indexable) posts. */
  readonly publishedPosts: number;
  readonly missingMetadesc: number | null;
  /** % of indexable posts with a meta description (Yoast only), else null. */
  readonly metadescCoverage: number | null;
  readonly missingFocusKw: number | null;
  /** % of indexable posts with a focus keyphrase (Yoast only), else null. */
  readonly focusKwCoverage: number | null;
  /** Whether Yoast's XML sitemap is enabled, or null when unknown/non-Yoast. */
  readonly sitemapEnabled: boolean | null;
}

export interface AudienceAnalytics {
  /** Detected analytics plugin label, or null when none is active. */
  readonly plugin: string | null;
}

export interface AudienceData {
  readonly seo: AudienceSeo;
  readonly analytics: AudienceAnalytics;
}

const SEO_LABELS: Readonly<Record<string, string>> = {
  "wordpress-seo": "Yoast SEO",
  "seo-by-rank-math": "Rank Math",
  "all-in-one-seo-pack": "All in One SEO",
};

const ANALYTICS_LABELS: Readonly<Record<string, string>> = {
  "google-site-kit": "Site Kit by Google",
  "ga-google-analytics": "GA Google Analytics",
  matomo: "Matomo Analytics",
  "independent-analytics": "Independent Analytics",
  "koko-analytics": "Koko Analytics",
};

/** Lowercased active plugin slug set from the plugin-list JSON. */
function activeSet(activePluginsJson: string): Set<string> {
  const active = new Set<string>();
  for (const row of parseJsonArray<{ name?: string }>(activePluginsJson)) {
    const name = fieldStr(row, "name")?.toLowerCase();
    if (name) active.add(name);
  }
  return active;
}

/** First recognised slug from `order` present in `active`, or null. */
function firstActive(active: ReadonlySet<string>, order: readonly string[]): string | null {
  for (const slug of order) if (active.has(slug)) return slug;
  return null;
}

/** Coverage % = covered / total, or null when the missing count is unavailable. */
function coverage(publishedPosts: number, missing: number | null): number | null {
  if (missing === null) return null;
  if (publishedPosts <= 0) return 100;
  const covered = Math.max(0, publishedPosts - missing);
  return Math.round((covered / publishedPosts) * 100);
}

/** Yoast persists `enable_xml_sitemap` in the `wpseo` option; read it truthily. */
function readSitemap(wpseoJson: string): boolean | null {
  const obj = parseJsonObject<Record<string, unknown>>(wpseoJson);
  if (!obj || !("enable_xml_sitemap" in obj)) return null;
  const v = obj.enable_xml_sitemap;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "on" || v.toLowerCase() === "true";
  return null;
}

export function parseAudience(input: {
  activePlugins: string;
  publishedPosts: string;
  missingMetadesc: string;
  missingFocusKw: string;
  sitemap: string;
}): AudienceData {
  const active = activeSet(input.activePlugins);
  const seoSlug = firstActive(active, SEO_PLUGIN_SLUGS);
  const analyticsSlug = firstActive(active, ANALYTICS_PLUGIN_SLUGS);
  const yoast = seoSlug === "wordpress-seo";

  const publishedPosts = toInt(input.publishedPosts) ?? 0;
  const missingMetadesc = yoast ? toInt(input.missingMetadesc) : null;
  const missingFocusKw = yoast ? toInt(input.missingFocusKw) : null;

  return {
    seo: {
      plugin: seoSlug ? SEO_LABELS[seoSlug] ?? seoSlug : null,
      yoast,
      publishedPosts,
      missingMetadesc,
      metadescCoverage: coverage(publishedPosts, missingMetadesc),
      missingFocusKw,
      focusKwCoverage: coverage(publishedPosts, missingFocusKw),
      sitemapEnabled: yoast ? readSitemap(input.sitemap) : null,
    },
    analytics: {
      plugin: analyticsSlug ? ANALYTICS_LABELS[analyticsSlug] ?? analyticsSlug : null,
    },
  };
}

// `\\\`` emits a literal backslash-backtick so the shell (inside the double-quoted
// SQL) treats the backtick as a MySQL identifier quote, not a command substitution;
// `$(wp … db prefix)` expands to the site's real table prefix.
const PREFIX = "$(wp --allow-root db prefix)";
function missingMetaSql(metaKey: string): string {
  return (
    `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` p ` +
    `LEFT JOIN \\\`${PREFIX}postmeta\\\` m ON p.ID=m.post_id AND m.meta_key='${metaKey}' ` +
    `WHERE p.post_type='post' AND p.post_status='publish' AND (m.meta_value IS NULL OR m.meta_value='')" ` +
    `--skip-column-names 2>/dev/null`
  );
}

async function fetchAudience(ctx: PanelProbeContext): Promise<AudienceData> {
  const activePlugins = await ctx
    .exec(`${WP} plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");

  const active = activeSet(activePlugins);
  const yoast = firstActive(active, SEO_PLUGIN_SLUGS) === "wordpress-seo";

  const [publishedPosts, missingMetadesc, missingFocusKw, sitemap] = await Promise.all([
    ctx
      .exec(`${WP_SAFE} post list --post_type=post --post_status=publish --format=count`)
      .then((r) => r.stdout)
      .catch(() => ""),
    yoast ? ctx.exec(missingMetaSql("_yoast_wpseo_metadesc")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
    yoast ? ctx.exec(missingMetaSql("_yoast_wpseo_focuskw")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
    yoast
      ? ctx.exec(`${WP_SAFE} option get wpseo --format=json 2>/dev/null`).then((r) => r.stdout).catch(() => "")
      : Promise.resolve(""),
  ]);

  return parseAudience({ activePlugins, publishedPosts, missingMetadesc, missingFocusKw, sitemap });
}

export const audienceProbe: PanelProbe<AudienceData> = {
  id: "audience",
  requiresCapability: "audience",
  fetch: fetchAudience,
};
