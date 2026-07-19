/**
 * A11y & SEO Audit panel probe — real, computed findings rather than a canned
 * checklist. Accessibility here means image alt-text coverage (a core WordPress
 * concern, independent of any plugin); on-page SEO coverage is derived from Yoast
 * metadata (meta description, focus keyphrase, title/meta templates). All numbers
 * come from guarded `wp db query` aggregates against the site's real table prefix.
 * Gated on the `seo` capability; when the active SEO plugin isn't Yoast the SEO
 * findings are omitted (their meta keys wouldn't apply) rather than reported as
 * total misses, and the panel notes that. Read-only: no allow-listed mutation, so
 * the panel renders no action buttons.
 */
import { WP, WP_SAFE, toInt, parseJsonObject, parseJsonArray, fieldStr } from "../wp-probe";
import { SEO_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type AuditCategory = "seo" | "a11y";
export type AuditSeverity = "critical" | "serious" | "moderate" | "minor";

export interface AuditFinding {
  readonly id: string;
  readonly category: AuditCategory;
  readonly severity: AuditSeverity;
  readonly label: string;
  readonly detail: string;
  readonly count: number;
}

export interface AuditData {
  /** Overall audit score (0–100), blended from the category scores. */
  readonly score: number;
  /** SEO sub-score, or null when the active SEO plugin isn't Yoast. */
  readonly seoScore: number | null;
  readonly a11yScore: number;
  readonly yoast: boolean;
  readonly publishedPosts: number;
  readonly imageAttachments: number;
  readonly titlesConfigured: boolean;
  readonly findings: readonly AuditFinding[];
}

/** covered / total as a 0–100 ratio; empty sets count as fully covered. */
function ratio(total: number, missing: number): number {
  if (total <= 0) return 1;
  return Math.max(0, total - missing) / total;
}

/** Lowercased active plugin slug set from the plugin-list JSON. */
function activeSet(activePluginsJson: string): Set<string> {
  const active = new Set<string>();
  for (const row of parseJsonArray<{ name?: string }>(activePluginsJson)) {
    const name = fieldStr(row, "name")?.toLowerCase();
    if (name) active.add(name);
  }
  return active;
}

export function parseAudit(input: {
  activePlugins: string;
  publishedPosts: string;
  missingMetadesc: string;
  missingFocusKw: string;
  imageAttachments: string;
  imagesMissingAlt: string;
  titles: string;
}): AuditData {
  const active = activeSet(input.activePlugins);
  const yoast = SEO_PLUGIN_SLUGS.some((slug) => slug === "wordpress-seo" && active.has(slug));

  const publishedPosts = toInt(input.publishedPosts) ?? 0;
  const imageAttachments = toInt(input.imageAttachments) ?? 0;
  const imagesMissingAlt = toInt(input.imagesMissingAlt) ?? 0;
  const missingMetadesc = toInt(input.missingMetadesc) ?? 0;
  const missingFocusKw = toInt(input.missingFocusKw) ?? 0;
  const titlesConfigured = parseJsonObject(input.titles) !== null;

  const findings: AuditFinding[] = [
    {
      id: "img-alt",
      category: "a11y",
      severity: "serious",
      label: "Images missing alt text",
      detail:
        imageAttachments === 0
          ? "No image attachments in the media library."
          : `${imagesMissingAlt} of ${imageAttachments} image attachments have no alt attribute.`,
      count: imagesMissingAlt,
    },
  ];

  if (yoast) {
    findings.push(
      {
        id: "meta-desc",
        category: "seo",
        severity: "moderate",
        label: "Posts missing a meta description",
        detail: `${missingMetadesc} of ${publishedPosts} published posts have no Yoast meta description.`,
        count: missingMetadesc,
      },
      {
        id: "focus-kw",
        category: "seo",
        severity: "minor",
        label: "Posts missing a focus keyphrase",
        detail: `${missingFocusKw} of ${publishedPosts} published posts have no focus keyphrase set.`,
        count: missingFocusKw,
      },
      {
        id: "titles",
        category: "seo",
        severity: "minor",
        label: "SEO title & meta templates",
        detail: titlesConfigured
          ? "Yoast title/meta templates are configured."
          : "Yoast title/meta templates are not configured.",
        count: titlesConfigured ? 0 : 1,
      },
    );
  }

  const a11yScore = Math.round(ratio(imageAttachments, imagesMissingAlt) * 100);
  const seoScore = yoast
    ? Math.round(
        (ratio(publishedPosts, missingMetadesc) * 0.4 +
          ratio(publishedPosts, missingFocusKw) * 0.4 +
          (titlesConfigured ? 1 : 0) * 0.2) *
          100,
      )
    : null;
  const score = seoScore === null ? a11yScore : Math.round((seoScore + a11yScore) / 2);

  return { score, seoScore, a11yScore, yoast, publishedPosts, imageAttachments, titlesConfigured, findings };
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

const IMAGE_COUNT_SQL =
  `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` ` +
  `WHERE post_type='attachment' AND post_mime_type LIKE 'image/%'" --skip-column-names 2>/dev/null`;

const IMAGE_MISSING_ALT_SQL =
  `${WP_SAFE} db query "SELECT COUNT(*) FROM \\\`${PREFIX}posts\\\` p ` +
  `LEFT JOIN \\\`${PREFIX}postmeta\\\` m ON p.ID=m.post_id AND m.meta_key='_wp_attachment_image_alt' ` +
  `WHERE p.post_type='attachment' AND p.post_mime_type LIKE 'image/%' AND (m.meta_value IS NULL OR m.meta_value='')" ` +
  `--skip-column-names 2>/dev/null`;

async function fetchAudit(ctx: PanelProbeContext): Promise<AuditData> {
  const activePlugins = await ctx
    .exec(`${WP} plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");

  const yoast = SEO_PLUGIN_SLUGS.some(
    (slug) => slug === "wordpress-seo" && activeSet(activePlugins).has(slug),
  );

  const [publishedPosts, imageAttachments, imagesMissingAlt, missingMetadesc, missingFocusKw, titles] =
    await Promise.all([
      ctx
        .exec(`${WP_SAFE} post list --post_type=post --post_status=publish --format=count`)
        .then((r) => r.stdout)
        .catch(() => ""),
      ctx.exec(IMAGE_COUNT_SQL).then((r) => r.stdout).catch(() => ""),
      ctx.exec(IMAGE_MISSING_ALT_SQL).then((r) => r.stdout).catch(() => ""),
      yoast ? ctx.exec(missingMetaSql("_yoast_wpseo_metadesc")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
      yoast ? ctx.exec(missingMetaSql("_yoast_wpseo_focuskw")).then((r) => r.stdout).catch(() => "") : Promise.resolve(""),
      yoast
        ? ctx.exec(`${WP_SAFE} option get wpseo_titles --format=json 2>/dev/null`).then((r) => r.stdout).catch(() => "")
        : Promise.resolve(""),
    ]);

  return parseAudit({
    activePlugins,
    publishedPosts,
    missingMetadesc,
    missingFocusKw,
    imageAttachments,
    imagesMissingAlt,
    titles,
  });
}

export const auditProbe: PanelProbe<AuditData> = {
  id: "audit",
  requiresCapability: "seo",
  fetch: fetchAudit,
};
