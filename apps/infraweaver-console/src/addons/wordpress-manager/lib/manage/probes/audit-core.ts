/**
 * The PURE core of the engine-aware SEO & A11y probe — types + the `parseAudit`
 * fold, with no exec and no signed transport, so the zero-WP jest harness covers it
 * end to end. `audit.ts` composes this with the wp-cli exec + signed `seo.status`
 * gather; the panel imports these DATA TYPES.
 *
 * Engine awareness (the anti-"Activate Yoast" fix, A3): when the signed snapshot
 * shows our SEO Suite (Ultimate) or Meta Audit (Pro) as the engine, the score +
 * coverage come from it; only when a third-party plugin (Yoast) is the engine do we
 * fall back to its meta coverage. Alt coverage always prefers the snapshot's
 * authoritative counts when present (one source, computed once).
 */
import { toInt, parseJsonObject, activePluginSlugs } from "../wp-probe";
import { SEO_PLUGIN_SLUGS } from "../capabilities";
import { summarizeSeoStatus, type SeoStatusResponse, type SeoSummary } from "../seo";

export type AuditCategory = "seo" | "a11y";
export type AuditSeverity = "critical" | "serious" | "moderate" | "minor";

/** Which engine measured on-page SEO — labels the score honestly. */
export type AuditEngine = "suite" | "audit" | "yoast" | "rankmath" | "aioseo" | null;

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
  /** SEO sub-score, or null when the active engine's coverage cannot be measured here. */
  readonly seoScore: number | null;
  readonly a11yScore: number;
  /** Which engine measured on-page SEO. */
  readonly engine: AuditEngine;
  /** Human label for the measuring engine ("SEO Suite", "Yoast SEO", …). */
  readonly engineName: string;
  readonly publishedPosts: number;
  readonly imageAttachments: number;
  readonly imagesMissingAlt: number;
  readonly findings: readonly AuditFinding[];
  /** The merged signed snapshot (null when no live link / connector too old). */
  readonly status: SeoStatusResponse | null;
  /** The engine-aware summary fold — the cockpit's score header + top fixes. */
  readonly summary: SeoSummary;
  /** True when the connector rejected `seo.status` as an unknown method (too old). */
  readonly connectorTooOld: boolean;
}

/** covered / total as a 0–100 ratio; empty sets count as fully covered. */
function ratio(total: number, missing: number): number {
  if (total <= 0) return 1;
  return Math.max(0, total - missing) / total;
}

/** Lowercased active plugin slug set from the plugin-list JSON. */
export function activeSet(activePluginsJson: string): Set<string> {
  return activePluginSlugs(activePluginsJson);
}

/** First recognised SEO slug present in `active`, or null. */
export function firstSeoSlug(active: ReadonlySet<string>): string | null {
  for (const slug of SEO_PLUGIN_SLUGS) if (active.has(slug)) return slug;
  return null;
}

const ENGINE_NAMES: Readonly<Record<Exclude<AuditEngine, null>, string>> = {
  suite: "SEO Suite",
  audit: "Meta Audit",
  yoast: "Yoast SEO",
  rankmath: "Rank Math",
  aioseo: "All in One SEO",
};

/** Map a third-party SEO slug to its engine id. */
function thirdPartyEngine(slug: string | null): Exclude<AuditEngine, "suite" | "audit" | null> | null {
  if (slug === "wordpress-seo") return "yoast";
  if (slug === "seo-by-rank-math") return "rankmath";
  if (slug === "all-in-one-seo-pack") return "aioseo";
  return null;
}

export interface ParseAuditInput {
  readonly status: SeoStatusResponse | null;
  readonly connectorTooOld: boolean;
  readonly activePlugins: string;
  readonly publishedPosts: string;
  readonly imageAttachments: string;
  readonly imagesMissingAlt: string;
  readonly missingMetadesc: string;
  readonly missingFocusKw: string;
  readonly titles: string;
}

/**
 * Pure fold from normalized inputs → engine-aware AuditData. Prefers the signed
 * snapshot's authoritative counts; only falls back to the third-party (Yoast) SQL
 * numbers when the platform engine is not the one measuring. Unit-tested with plain
 * strings/objects (no exec, no fetch).
 */
export function parseAudit(input: ParseAuditInput): AuditData {
  const active = activeSet(input.activePlugins);
  const thirdSlug = firstSeoSlug(active);
  const thirdEngine = thirdPartyEngine(thirdSlug);
  const status = input.status;

  const suiteOpen = status?.engines.suite.unlocked === true;
  const auditOpen = status?.engines.audit.unlocked === true && status?.engines.audit.last != null;
  const usePlatform = suiteOpen || auditOpen;
  const engine: AuditEngine = suiteOpen ? "suite" : auditOpen ? "audit" : thirdEngine;
  const engineName = engine ? ENGINE_NAMES[engine] : "No SEO engine";

  // Alt coverage — prefer the signed snapshot's authoritative counts (A3/C1).
  const imageAttachments = status ? status.alt.images : toInt(input.imageAttachments) ?? 0;
  const imagesMissingAlt = status ? status.alt.missing : toInt(input.imagesMissingAlt) ?? 0;
  const publishedPosts = toInt(input.publishedPosts) ?? status?.schema?.published ?? 0;

  const yoast = engine === "yoast";
  const missingMetadesc = yoast ? toInt(input.missingMetadesc) ?? 0 : 0;
  const missingFocusKw = yoast ? toInt(input.missingFocusKw) ?? 0 : 0;
  const titlesConfigured = yoast ? parseJsonObject(input.titles) !== null : false;

  const summary = summarizeSeoStatus(status);

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

  if (usePlatform && status) {
    // Two-engine conflict (suite + a third-party SEO plugin both active) — A6.
    if (status.conflicting_engines.length > 0) {
      findings.push({
        id: "engine-conflict",
        category: "seo",
        severity: "serious",
        label: "Two SEO engines are active",
        detail: `The platform SEO Suite is fighting ${status.conflicting_engines.length} third-party SEO plugin(s) — both emit canonicals & titles. Deactivate one.`,
        count: status.conflicting_engines.length,
      });
    }
    // Whole-site invisibility (everything noindexed / not public) — A4 critical.
    if (summary.invisible) {
      findings.push({
        id: "invisible",
        category: "seo",
        severity: "critical",
        label: "Site hidden from search engines",
        detail: `${status.noindexed} published item(s) are set to noindex — your site is invisible in search.`,
        count: status.noindexed,
      });
    }
    if (auditOpen && status.engines.audit.last) {
      const missingDesc = status.engines.audit.last.issue_counts["missing-meta-description"] ?? 0;
      findings.push({
        id: "meta-desc",
        category: "seo",
        severity: "moderate",
        label: "Pages missing a meta description",
        detail: `${missingDesc} of ${status.engines.audit.last.scanned} audited page(s) have no meta description.`,
        count: missingDesc,
      });
    }
    if (suiteOpen && status.keywords.missing > 0) {
      findings.push({
        id: "focus-kw",
        category: "seo",
        severity: "minor",
        label: "Pages without a focus keyphrase",
        detail: `${status.keywords.missing} of ${status.keywords.set + status.keywords.missing} page(s) have no focus keyphrase.`,
        count: status.keywords.missing,
      });
    }
  } else if (yoast) {
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
        detail: titlesConfigured ? "Yoast title/meta templates are configured." : "Yoast title/meta templates are not configured.",
        count: titlesConfigured ? 0 : 1,
      },
    );
  }

  const a11yScore = Math.round(ratio(imageAttachments, imagesMissingAlt) * 100);

  let seoScore: number | null = null;
  if (usePlatform) {
    seoScore = summary.score;
  } else if (yoast) {
    seoScore = Math.round(
      (ratio(publishedPosts, missingMetadesc) * 0.4 + ratio(publishedPosts, missingFocusKw) * 0.4 + (titlesConfigured ? 1 : 0) * 0.2) * 100,
    );
  }

  const score = seoScore === null ? a11yScore : Math.round((seoScore + a11yScore) / 2);

  return {
    score,
    seoScore,
    a11yScore,
    engine,
    engineName,
    publishedPosts,
    imageAttachments,
    imagesMissingAlt,
    findings,
    status,
    summary,
    connectorTooOld: input.connectorTooOld,
  };
}
