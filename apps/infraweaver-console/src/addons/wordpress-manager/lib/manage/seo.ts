/**
 * SEO console surface — the isomorphic TYPES + zod request validators for the four
 * signed `seo.*` commands (`seo.status`, `seo.audit.run`, `seo.alt.backfill`,
 * `seo.fix.apply`). Isomorphic (no `server-only`): the API route parses requests
 * through these schemas, the client narrows responses against these types, and the
 * pure `summarizeSeoStatus` fold is reused by the audit probe AND the Overview tile.
 *
 * Every bound + enum vocabulary MIRRORS the connector's `IWSL_SEO_Console`
 * validators (`validate_audit_params` / `validate_backfill_params` /
 * `validate_fix_params`) so the two sides can never drift — a request this module
 * accepts is one the plugin's validator also accepts, and vice-versa.
 */

import { z } from "zod";

// ── bounds (mirror IWSL_SEO_Console / IWSL_SEO_Audit constants; keep in lockstep) ─
/** `IWSL_SEO_Audit::MAX_ITEMS` — the audit corpus ceiling and `limit` cap. */
export const AUDIT_MAX_ITEMS = 200;
/** `IWSL_SEO_Console::WIRE_ITEM_CAP` — items serialized onto the signed wire. */
export const AUDIT_WIRE_ITEM_CAP = 50;
/** `IWSL_SEO_Console::MAX_BATCH` — attachments scanned per alt-backfill run. */
export const ALT_BATCH_MAX = 200;
/** `IWSL_SEO_Console::ALT_SAMPLE_CAP` — preview samples a backfill run returns. */
export const ALT_SAMPLE_CAP = 10;
/** `IWSL_SEO_Console::MAX_FIX_VALUE` — byte ceiling on a fix value. */
export const FIX_VALUE_MAX = 400;

/** The STRICT field allow-list for `seo.fix.apply` (mirrors `IWSL_SEO_Console::FIX_FIELDS`). */
export const FIX_FIELDS = ["title", "desc", "focuskw", "noindex"] as const;
export type SeoFixField = (typeof FIX_FIELDS)[number];

// ── seo.status result (mirrors IWSL_SEO_Console::fold_status) ──────────────────

export interface SeoAuditLastCounts {
  readonly scanned: number;
  readonly with_issues: number;
  readonly issue_counts: Readonly<Record<string, number>>;
  readonly generated_at: string;
}

export interface SeoSuiteEngine {
  readonly unlocked: boolean;
  readonly switched_off: boolean;
  readonly score_avg: number | null;
  readonly histogram: { readonly good: number; readonly ok: number; readonly poor: number; readonly none: number };
  readonly sitemap: { readonly active: boolean; readonly url: string | null };
  readonly robots_managed: boolean;
}

export interface SeoAuditEngine {
  readonly unlocked: boolean;
  readonly switched_off: boolean;
  readonly last: SeoAuditLastCounts | null;
}

export interface SeoStatusResponse {
  readonly ok: boolean;
  readonly engines: { readonly suite: SeoSuiteEngine; readonly audit: SeoAuditEngine };
  readonly alt: { readonly images: number; readonly missing: number };
  readonly keywords: { readonly set: number; readonly missing: number; readonly duplicates: number };
  readonly schema: { readonly site_representation: boolean; readonly typed_posts: number; readonly published: number } | null;
  readonly four04: { readonly logged: number; readonly auto_redirect: boolean } | null;
  readonly noindexed: number;
  readonly conflicting_engines: readonly string[];
}

// ── seo.audit.run result (mirrors IWSL_SEO_Audit summary + cap_wire_items) ──────

/** One audited post/page — the connector emits `{ id, title, issues[] }` per item. */
export interface SeoAuditItem {
  readonly id: number;
  readonly title: string;
  readonly issues: readonly string[];
}

export interface SeoAuditSummary {
  readonly ok: boolean;
  readonly generated_at: string;
  readonly scanned: number;
  readonly with_issues: number;
  readonly issue_counts: Readonly<Record<string, number>>;
  readonly items: readonly SeoAuditItem[];
  readonly partial: boolean;
  readonly max: number;
  /** True when more items were found than serialized (`WIRE_ITEM_CAP`). */
  readonly item_capped?: boolean;
  readonly wire_item_cap?: number;
}

/** The gate descriptor the connector returns for a locked runner. */
export interface SeoGate {
  readonly unlocked?: boolean;
  readonly reasons?: readonly string[];
  readonly switched_off?: boolean;
  readonly tier?: string;
}

/** A locked reply (entitlement / feature-switch closed) from any gated `seo.*` runner. */
export interface SeoLockedResult {
  readonly ok: false;
  readonly locked: true;
  readonly reason: "entitlement-locked";
  readonly gate: SeoGate;
}

export type SeoAuditRunResult = SeoAuditSummary | SeoLockedResult;

// ── seo.alt.backfill result (mirrors IWSL_SEO_Console::backfill_alt) ────────────

export interface SeoAltBackfillResult {
  readonly ok: true;
  readonly dry_run: boolean;
  readonly scanned: number;
  readonly fillable: number;
  readonly filled: number;
  readonly remaining: number;
  readonly samples: readonly { readonly id: number; readonly derived: string }[];
}

export type SeoAltBackfillResponse = SeoAltBackfillResult | SeoLockedResult;

// ── seo.fix.apply result (mirrors IWSL_SEO_Console::apply_fix) ──────────────────

export interface SeoFixAppliedResult {
  readonly ok: true;
  readonly applied: boolean;
  readonly field: SeoFixField;
  readonly stored: string;
}

export type SeoFixApplyResponse = SeoFixAppliedResult | SeoLockedResult | { readonly ok: false; readonly reason: string };

/** True when a `seo.*` reply is the structured locked upsell (not a raw error). */
export function isSeoLocked(value: unknown): value is SeoLockedResult {
  return typeof value === "object" && value !== null && (value as { locked?: unknown }).locked === true;
}

// ── request validators (parity with the connector's validate_* methods) ─────────

/** `seo.audit.run` params — optional `limit` 1..200, no stray keys (validate_audit_params). */
export const seoAuditParamsSchema = z
  .object({ limit: z.number().int().min(1).max(AUDIT_MAX_ITEMS).optional() })
  .strict();
export type SeoAuditParams = z.infer<typeof seoAuditParamsSchema>;

/** `seo.alt.backfill` params — optional `limit` 1..200 + optional `dry_run` (validate_backfill_params). */
export const seoAltBackfillParamsSchema = z
  .object({ limit: z.number().int().min(1).max(ALT_BATCH_MAX).optional(), dry_run: z.boolean().optional() })
  .strict();
export type SeoAltBackfillParams = z.infer<typeof seoAltBackfillParamsSchema>;

/** `seo.fix.apply` params — EXACTLY { post_id>0, field:enum, value:string≤400 } (validate_fix_params). */
export const seoFixParamsSchema = z
  .object({
    post_id: z.number().int().positive(),
    field: z.enum(FIX_FIELDS),
    value: z.string().max(FIX_VALUE_MAX),
  })
  .strict();
export type SeoFixParams = z.infer<typeof seoFixParamsSchema>;

/** The write verbs the SEO route dispatches (one signed method per verb). */
export const SEO_WRITE_VERBS = ["audit-run", "alt-backfill", "fix"] as const;
export type SeoWriteVerb = (typeof SEO_WRITE_VERBS)[number];

/** The read verbs (GET) the SEO route serves. */
export const SEO_READ_VERBS = ["status"] as const;
export type SeoReadVerb = (typeof SEO_READ_VERBS)[number];

// ── pure fold: the shared score + top-fixes summary (probe + Overview reuse) ────

/** Which SEO engine measured a site — labels the score honestly, drives fallbacks. */
export type SeoEngine = "suite" | "audit" | "yoast" | null;
export type SeoRating = "good" | "warn" | "critical" | "unknown";

export interface SeoTopFix {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly severity: "critical" | "serious" | "moderate" | "minor";
  /** The SEO sub-focus the Overview jump should carry (kept generic: the SEO panel). */
  readonly focus?: string;
}

/** The compact, engine-aware SEO summary the Overview tile + attention feed render. */
export interface SeoSummary {
  /** False ⇒ "not measured" (no engine active / connector too old) — never an error. */
  readonly measured: boolean;
  readonly engine: SeoEngine;
  /** 0–100 blended score, or null when unmeasured. */
  readonly score: number | null;
  readonly rating: SeoRating;
  /** The worst 1–2 fixes, severity-ordered — feed the Overview "what needs me". */
  readonly topFixes: readonly SeoTopFix[];
  /** True when the whole site is noindexed / not public — a critical visibility loss. */
  readonly invisible: boolean;
  /** Third-party engines running alongside our suite (two-engine conflict). */
  readonly conflictingEngines: readonly string[];
}

const SEVERITY_RANK: Readonly<Record<SeoTopFix["severity"], number>> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

/** Traffic-light rating for a 0–100 SEO score (null ⇒ unknown). */
export function seoRating(score: number | null): SeoRating {
  if (score === null) return "unknown";
  if (score >= 70) return "good";
  if (score >= 40) return "warn";
  return "critical";
}

/**
 * Blend the suite per-post score histogram into a single 0–100 site score. Good
 * posts count full, ok posts half, poor/none count zero — a coverage-weighted
 * average over the published corpus. Falls back to the connector's own average
 * when the histogram is empty; null when there is nothing to score.
 */
function suiteScore(engine: SeoSuiteEngine): number | null {
  const h = engine.histogram;
  const total = h.good + h.ok + h.poor + h.none;
  if (total <= 0) return engine.score_avg;
  return Math.round(((h.good + h.ok * 0.5) / total) * 100);
}

/** Coverage % = covered/total, clamped 0–100; empty corpus reads as fully covered. */
function coveragePct(total: number, missing: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((total - missing) / total) * 100)));
}

/**
 * Fold a signed `seo.status` snapshot into the engine-aware summary the Overview
 * tile + attention feed and the audit probe all render. Pure — unit-tested with
 * plain objects. Prefers the suite score when unlocked, else the audit coverage,
 * else leaves it unmeasured (the Yoast fallback is layered on by the probe, which
 * has the third-party numbers `seo.status` cannot see).
 */
export function summarizeSeoStatus(status: SeoStatusResponse | null): SeoSummary {
  if (!status) {
    return { measured: false, engine: null, score: null, rating: "unknown", topFixes: [], invisible: false, conflictingEngines: [] };
  }
  const suite = status.engines.suite;
  const audit = status.engines.audit;
  const conflicting = [...status.conflicting_engines];

  let engine: SeoEngine = null;
  let score: number | null = null;
  if (suite.unlocked) {
    engine = "suite";
    score = suiteScore(suite);
  } else if (audit.unlocked && audit.last) {
    engine = "audit";
    score = coveragePct(audit.last.scanned, audit.last.with_issues);
  }

  const fixes: SeoTopFix[] = [];
  if (status.alt.missing > 0 && status.alt.images > 0) {
    fixes.push({
      key: "alt",
      label: `${status.alt.missing} image${status.alt.missing === 1 ? "" : "s"} missing alt text`,
      count: status.alt.missing,
      severity: "serious",
      focus: "alt",
    });
  }
  if (suite.unlocked && status.keywords.missing > 0) {
    fixes.push({
      key: "keywords",
      label: `${status.keywords.missing} page${status.keywords.missing === 1 ? "" : "s"} without a focus keyphrase`,
      count: status.keywords.missing,
      severity: "minor",
      focus: "keywords",
    });
  }
  if (audit.unlocked && audit.last) {
    const missingDesc = audit.last.issue_counts["missing-meta-description"] ?? 0;
    if (missingDesc > 0) {
      fixes.push({
        key: "meta-desc",
        label: `${missingDesc} page${missingDesc === 1 ? "" : "s"} missing a meta description`,
        count: missingDesc,
        severity: "moderate",
        focus: "audit",
      });
    }
  }

  // A fully-noindexed corpus (or blog_public off) is a critical visibility loss.
  const invisible =
    suite.unlocked && status.schema !== null && status.schema.published > 0 && status.noindexed >= status.schema.published;
  if (invisible) {
    fixes.unshift({
      key: "invisible",
      label: "Your site is hidden from search engines",
      count: status.noindexed,
      severity: "critical",
      focus: "visibility",
    });
  }

  const topFixes = [...fixes].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 2);
  return { measured: engine !== null, engine, score, rating: seoRating(score), topFixes, invisible, conflictingEngines: conflicting };
}

// ── issue-code labels + fixable mapping (mirrors IWSL_SEO_Audit::labels) ────────

/** Human labels for the audit issue codes (render only) — mirrors the connector's labels(). */
export const AUDIT_ISSUE_LABELS: Readonly<Record<string, string>> = {
  "missing-title": "Missing title",
  "title-too-long": "Title too long",
  "title-too-short": "Title too short",
  "missing-meta-description": "Missing meta description",
  "thin-content": "Thin content",
  "missing-featured-image": "No featured image",
  "no-heading": "No heading (h1–h6)",
  "duplicate-title": "Duplicate title (shared with another page)",
  "duplicate-meta-description": "Duplicate meta description",
  "orphan-page": "Orphan page (no internal links point here)",
  "keyphrase-cannibalization": "Keyphrase used on more than one page",
};

/** Human label for an issue code, falling back to the raw code. */
export function auditIssueLabel(code: string): string {
  return AUDIT_ISSUE_LABELS[code] ?? code;
}

/** The one-click fix field an audit issue maps to, or null when it needs content work. */
export function fixFieldForIssue(code: string): SeoFixField | null {
  if (code === "missing-title" || code === "title-too-long" || code === "title-too-short") return "title";
  if (code === "missing-meta-description") return "desc";
  return null;
}
