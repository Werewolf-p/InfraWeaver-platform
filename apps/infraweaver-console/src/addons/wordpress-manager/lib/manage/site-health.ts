/**
 * Site Health — the ISOMORPHIC contract shared by the signed-channel wrappers
 * (`iwsl-managed-ops`), the API handler, the `health` probe and the panel
 * components. No `server-only` here: types + zod schemas only, so the client
 * panel and the server probe import the same shapes and can never drift.
 *
 * Every shape mirrors the connector's `IWSL_Site_Health::snapshot()` and the
 * eight signed methods (`sitehealth.snapshot`, `links.scan`, `redirects.*`,
 * `maintenance.set`). The plugin is the source of truth — these types are
 * best-effort projections and the zod schemas mirror the plugin's *shape*
 * validators (the authoritative gauntlet + entitlement gate stay in the engine).
 */

import { z } from "zod";

// ── bounds mirrored from the connector (documentation + client sanity) ─────────

/** A stored redirect id: `r` + 12 hex (server-derived sha1 of the source path). */
export const RULE_ID_RE = /^r[0-9a-f]{12}$/;

/** Redirect status codes the engine supports (301 permanent, 302 temporary). */
export const REDIRECT_TYPES = [301, 302] as const;
export type RedirectType = (typeof REDIRECT_TYPES)[number];

/** How a rule matches the request path. `exact` is the legacy default. */
// Only the matchers the connector actually registers. There is deliberately no
// "regex" matcher (a bad-match request fails closed), so it is not offered.
export const REDIRECT_MATCHES = ["exact", "prefix"] as const;
export type RedirectMatch = (typeof REDIRECT_MATCHES)[number];

/** Import cap — mirrors `$redirects_import_params` (≤ 50 rows per call). */
export const MAX_IMPORT_RULES = 50;
/** Maintenance allow-list cap — mirrors the engine sanitizer (≤ 10 literal IPs). */
export const MAX_ALLOW_IPS = 10;
/** `links.scan` budget clamp (ms) — the engine clamps to this range too. */
export const SCAN_BUDGET_MIN_MS = 5_000;
export const SCAN_BUDGET_MAX_MS = 20_000;
/** Lower default clamp the console chooses for a scan (bounded round-trip). */
export const SCAN_BUDGET_DEFAULT_MS = 15_000;
/** Byte caps the engine enforces on the holding page copy (client hints only). */
export const HEADLINE_MAX = 200;
export const MESSAGE_MAX = 1_000;
/** Auto-off window ceiling — the engine clamps `until` to ≤ 7 days ahead. */
export const UNTIL_MAX_AHEAD_S = 7 * 24 * 60 * 60;

// ── snapshot sub-shapes (mirror IWSL_Site_Health::snapshot) ────────────────────

export interface SiteHealthSwitches {
  readonly maintenance_mode: boolean;
  readonly redirect_manager: boolean;
  readonly broken_link_scan: boolean;
  readonly statistics: boolean;
}

/** Maintenance state as the snapshot reports it (or a locked marker). */
export interface MaintenanceState {
  readonly locked: boolean;
  readonly enabled?: boolean;
  readonly headline?: string;
  readonly message?: string;
  readonly retry_after?: boolean;
  readonly until?: number;
  readonly allow_ips?: readonly string[];
  readonly saved_at?: number;
}

/** One broken anchor from a scan summary. */
export interface BrokenLink {
  readonly post_id: number;
  readonly post_title: string;
  readonly url: string;
  readonly status: number | string;
}

/** One broken `<img src>` — feeds the Media explorer's "broken" filter. */
export interface BrokenImage {
  readonly post_id: number;
  readonly url: string;
  readonly attachment_id: number | null;
  readonly status: number | string;
}

/** The immutable scan summary the connector persists as `broken_link_scan_last`. */
export interface LinkScanSummary {
  readonly ok?: boolean;
  readonly reason?: string;
  readonly scanned_posts?: number;
  readonly checked_links?: number;
  readonly broken_count?: number;
  readonly broken?: readonly BrokenLink[];
  readonly broken_images?: readonly BrokenImage[];
  readonly partial?: boolean;
  readonly elapsed_ms?: number;
  readonly max_posts?: number;
  readonly max_links?: number;
  readonly budget_ms?: number;
  readonly generated_at?: number;
}

export interface LinksView {
  readonly locked: boolean;
  readonly last_scan_summary: LinkScanSummary | null;
}

/** A redirect rule as projected into the snapshot `top` list. */
export interface RedirectRuleTop {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: number;
  readonly match: string;
  readonly hits: number;
  readonly external: boolean;
}

/** The full stored rule (redirects.list) — adds bookkeeping fields. */
export interface RedirectRule extends RedirectRuleTop {
  readonly created_at?: number;
  readonly auto?: boolean;
}

export interface RedirectsView {
  readonly locked: boolean;
  readonly count: number;
  readonly log_enabled: boolean;
  readonly auto_slug: boolean;
  readonly top: readonly RedirectRuleTop[];
}

export interface NotFoundRow {
  readonly path: string;
  readonly count: number;
  readonly last_seen: number;
  readonly source: string;
}

export interface NotFoundView {
  readonly locked: boolean;
  readonly top: readonly NotFoundRow[];
}

export interface RedirectSuggestion {
  readonly path: string;
  readonly target: string;
  readonly confidence: string;
}

/** The one bounded aggregate powering the whole Site Health panel. */
export interface SiteHealthSnapshot {
  readonly switches: SiteHealthSwitches;
  readonly maintenance: MaintenanceState;
  readonly links: LinksView;
  readonly redirects: RedirectsView;
  readonly notfound: NotFoundView;
  readonly suggestions: readonly RedirectSuggestion[];
  readonly broken_images: readonly BrokenImage[];
}

// ── detail-read + mutation reply shapes (best-effort; plugin is authoritative) ──

/** `redirects.list` reply — the full table, or a locked marker. */
export interface RedirectsListResult {
  readonly locked: boolean;
  readonly rules?: readonly RedirectRule[];
  readonly log?: readonly NotFoundRow[];
  readonly log_enabled?: boolean;
  readonly auto_slug?: boolean;
  readonly gate?: Record<string, unknown>;
}

/** `redirects.create` / `redirects.delete` reply — `add_rule`/`delete_rule` verbatim. */
export interface RedirectMutationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly rule?: RedirectRule;
  readonly deleted?: boolean;
  readonly rules_count?: number;
}

/** `redirects.import` reply — per-row ok/refusal, stop-never. */
export interface RedirectImportResult {
  readonly results: ReadonlyArray<{ readonly ok: boolean; readonly reason?: string }>;
}

/** `redirects.set_toggles` reply — the two current toggle states. */
export interface RedirectTogglesResult {
  readonly log_enabled: boolean;
  readonly auto_slug: boolean;
}

/** `maintenance.set` reply — `save_settings()` verbatim (or a locked marker). */
export interface MaintenanceSetResult {
  readonly ok?: boolean;
  readonly locked?: boolean;
  readonly settings?: MaintenanceState;
  readonly gate?: Record<string, unknown>;
}

// ── zod param schemas (mirror the plugin allow-list *shape* validators) ─────────

/** `links.scan` — `{ budget_ms? }`, integer, strict keys. */
export const linkScanParamsSchema = z
  .object({ budget_ms: z.number().int().optional() })
  .strict();
export type LinkScanParams = z.infer<typeof linkScanParamsSchema>;

/**
 * `redirects.create` — shape-checked only (source/target strings, type 301|302,
 * optional `match`). The engine's `add_rule()` runs the authoritative gauntlet;
 * the console never re-implements it, so this stays a thin shape guard.
 */
export const redirectCreateParamsSchema = z
  .object({
    source: z.string().min(1).max(2048),
    target: z.string().min(1).max(2048),
    type: z.union([z.literal(301), z.literal(302)]),
    match: z.enum(REDIRECT_MATCHES).optional(),
  })
  .strict();
export type RedirectCreateParams = z.infer<typeof redirectCreateParamsSchema>;

/** `redirects.delete` — `{ id }` matching the server-derived id shape. */
export const redirectDeleteParamsSchema = z
  .object({ id: z.string().regex(RULE_ID_RE, "invalid rule id") })
  .strict();
export type RedirectDeleteParams = z.infer<typeof redirectDeleteParamsSchema>;

/** `redirects.import` — `{ rules: [...] }`, ≤ 50 rows, each shape-checked. */
export const redirectImportParamsSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            source: z.string().min(1).max(2048),
            target: z.string().min(1).max(2048),
            type: z.union([z.literal(301), z.literal(302)]),
            match: z.enum(REDIRECT_MATCHES).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_IMPORT_RULES),
  })
  .strict();
export type RedirectImportParams = z.infer<typeof redirectImportParamsSchema>;

/** `redirects.set_toggles` — `{ log_404?, auto_slug? }` booleans, strict keys. */
export const redirectTogglesParamsSchema = z
  .object({ log_404: z.boolean().optional(), auto_slug: z.boolean().optional() })
  .strict();
export type RedirectTogglesParams = z.infer<typeof redirectTogglesParamsSchema>;

/**
 * `maintenance.set` — `{ enabled, headline?, message?, retry_after?, until?,
 * allow_ips? }`. The engine sanitizer applies the byte caps, the `until` clamp
 * and the IP normalization; this bounds input defensively (allow-list ≤ 10) but
 * does not pre-empt the engine.
 */
export const maintenanceSetParamsSchema = z
  .object({
    enabled: z.boolean(),
    headline: z.string().max(HEADLINE_MAX * 4).optional(),
    message: z.string().max(MESSAGE_MAX * 4).optional(),
    retry_after: z.boolean().optional(),
    until: z.number().int().min(0).optional(),
    allow_ips: z.array(z.string().min(1).max(45)).max(MAX_ALLOW_IPS).optional(),
  })
  .strict();
export type MaintenanceSetParams = z.infer<typeof maintenanceSetParamsSchema>;

// ── API verb catalogs (the dedicated site-health route dispatches on these) ─────

export const SITE_HEALTH_READ_VERBS = ["snapshot", "redirects"] as const;
export type SiteHealthReadVerb = (typeof SITE_HEALTH_READ_VERBS)[number];

export const SITE_HEALTH_WRITE_VERBS = [
  "scan",
  "redirect-create",
  "redirect-delete",
  "redirect-import",
  "redirect-toggles",
] as const;
export type SiteHealthWriteVerb = (typeof SITE_HEALTH_WRITE_VERBS)[number];

/** Clamp a requested scan budget into the connector's accepted range. Pure. */
export function clampScanBudgetMs(budget: number | undefined): number {
  if (budget === undefined || !Number.isFinite(budget)) return SCAN_BUDGET_DEFAULT_MS;
  return Math.max(SCAN_BUDGET_MIN_MS, Math.min(SCAN_BUDGET_MAX_MS, Math.trunc(budget)));
}
