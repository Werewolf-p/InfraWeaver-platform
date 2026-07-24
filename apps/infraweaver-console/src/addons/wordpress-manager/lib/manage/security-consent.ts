/**
 * Site Security / Consent / Protection — the console-side TYPES + zod request
 * validators + PURE fusion helpers for the five signed methods behind the fused
 * Site Security surface:
 *
 *   security.scan       (read)  — HTTP security-header grade + tracker detection
 *   security.harden     (write) — apply an ALLOW-LISTED, closed-enum hardening config
 *   consent.getConfig   (read)  — cookie-consent settings + privacy-safe aggregates
 *   consent.setConfig   (write) — persist consent settings through the plugin gauntlet
 *   protection.status   (read)  — cross-feature status aggregate (media/svg/consent/headers)
 *
 * Isomorphic (no `server-only`): the API route parses requests through these
 * schemas, and the client narrows responses against these types. Every bound +
 * enum vocabulary MIRRORS `IWSL_Security_Headers` / `IWSL_Cookie_Consent` so the
 * two sides can never drift — a request this module accepts is one the plugin's
 * validator also accepts, and the `security.harden` validator is a CLOSED key/enum
 * set so a free-form header name or value (header injection) is refused here too.
 */

import { z } from "zod";
import type { CheckState, SecurityData } from "./probes/security";

// ── closed enum vocabularies (mirror IWSL_Security_Headers constants) ──────────
/** X-Frame-Options values the hardening surface offers. */
export const FRAME_VALUES = ["deny", "sameorigin"] as const;
/** Referrer-Policy values (deliberately EXCLUDES the leaky `unsafe-url`). */
export const REFERRER_VALUES = [
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
] as const;
/** CSP mode. `enforce` is the deliberate second step after `report-only`. */
export const CSP_VALUES = ["off", "report-only", "enforce"] as const;

export type FrameValue = (typeof FRAME_VALUES)[number];
export type ReferrerValue = (typeof REFERRER_VALUES)[number];
export type CspValue = (typeof CSP_VALUES)[number];

// ── security.scan response shapes (mirror IWSL_Security_Headers::grade_headers) ─
export type HeaderState = "good" | "weak" | "missing";
export type SecurityGrade = "A" | "B" | "C" | "D" | "F";

export interface SecurityHeaderRow {
  readonly name: string;
  readonly state: HeaderState;
  readonly value_hint: string;
  readonly why: string;
}

export interface SecurityLeakRow {
  readonly name: string;
  readonly value_hint: string;
  readonly why: string;
}

export interface DetectedVendor {
  readonly vendor: string;
  readonly label: string;
  readonly category: string;
  readonly count: number;
}

/** The gate descriptor the connector returns for a locked feature. */
export interface SecurityGate {
  readonly unlocked?: boolean;
  readonly reason?: string;
  readonly tier?: string;
}

/**
 * `security.scan` result. `ok` is the INNER verdict: `false` on a fetch failure
 * (with `reason`), even though the transport reply succeeded. `locked` is set only
 * when the tier does not grant `security_headers` (the connector answered a signed
 * `{ locked, gate }`), so the surface can show a TierGate rather than an error.
 */
export interface SecurityScanResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly grade?: SecurityGrade;
  readonly score?: number;
  readonly headers?: readonly SecurityHeaderRow[];
  readonly leaks?: readonly SecurityLeakRow[];
  readonly detected_vendors?: readonly DetectedVendor[];
  readonly scanned_at?: number;
  readonly locked?: boolean;
  readonly gate?: SecurityGate;
}

/** The stored hardening config (mirror IWSL_Security_Headers::sanitize_config). */
export interface HardeningConfig {
  readonly hsts: boolean;
  readonly nosniff: boolean;
  readonly frame: "" | FrameValue;
  readonly referrer: "" | ReferrerValue;
  readonly permissions: boolean;
  readonly csp: CspValue;
}

export interface SecurityHardenResult {
  readonly applied?: HardeningConfig;
  readonly locked?: boolean;
  readonly gate?: SecurityGate;
  readonly reason?: string;
}

// ── consent.getConfig / setConfig response shapes (mirror IWSL_Cookie_Consent) ─
export interface ConsentCategories {
  readonly necessary: boolean;
  readonly preferences: boolean;
  readonly statistics: boolean;
  readonly marketing: boolean;
}

export interface ConsentSettings {
  readonly enabled: boolean;
  readonly banner_layout?: string;
  readonly default_model?: string;
  readonly consent_mode?: boolean;
  readonly respect_gpc?: boolean;
  readonly respect_dnt?: boolean;
  readonly policy_version?: number;
  readonly title?: string;
  readonly message?: string;
  readonly policy_url?: string;
  readonly accent?: string;
  readonly categories?: ConsentCategories;
  readonly vendor_overrides?: Record<string, string>;
  readonly saved_at?: number;
}

/** Privacy-safe aggregates — COUNTS ONLY; no raw consent-log row ever crosses. */
export interface ConsentAggregates {
  readonly records: number;
  readonly by_method: Record<string, number>;
  readonly by_region: Record<string, number>;
  readonly policy_version: number;
}

export interface ConsentConfigResponse {
  readonly settings?: ConsentSettings;
  readonly enabled?: boolean;
  readonly aggregates?: ConsentAggregates;
  readonly locked?: boolean;
  readonly gate?: SecurityGate;
}

export interface ConsentSetResult {
  readonly settings?: ConsentSettings;
  readonly locked?: boolean;
  readonly gate?: SecurityGate;
  readonly reason?: string;
}

// ── protection.status response shape (mirror the plugin's aggregate runner) ────
export interface ProtectionFeature {
  readonly entitled: boolean;
  readonly enabled: boolean;
}

export interface MediaProtectionStatus extends ProtectionFeature {
  readonly protect_all: boolean;
  readonly protected_count: number;
}

export interface CookieConsentStatus extends ProtectionFeature {
  readonly policy_version: number;
}

export interface SecurityHeadersStatus {
  readonly entitled: boolean;
  readonly config: HardeningConfig;
}

export interface ProtectionStatusResponse {
  readonly media_protection: MediaProtectionStatus;
  readonly svg_upload: ProtectionFeature;
  readonly cookie_consent: CookieConsentStatus;
  readonly security_headers: SecurityHeadersStatus;
}

// ── request validators (parity with the plugin's validate_params) ─────────────

/**
 * The CLOSED hardening-config schema. `.strict()` refuses any key that is not a
 * recognized config field (so `{ "X-Evil": "…" }` — an arbitrary header name — is
 * rejected), and every value is bound to its boolean/enum type. There is NEVER a
 * free-form header value, which forecloses header injection by construction, in
 * lockstep with `IWSL_Security_Headers::validate_params`.
 */
const hardenConfigSchema = z
  .object({
    hsts: z.boolean().optional(),
    nosniff: z.boolean().optional(),
    frame: z.enum(FRAME_VALUES).optional(),
    referrer: z.enum(REFERRER_VALUES).optional(),
    permissions: z.boolean().optional(),
    csp: z.enum(CSP_VALUES).optional(),
  })
  .strict();

/**
 * `security.harden` params. Either `config` or `revert` must be present (an empty
 * command is not valid — mirrors the plugin refusing no-op params), and no stray
 * top-level key is allowed.
 */
export const securityHardenParamsSchema = z
  .object({
    config: hardenConfigSchema.optional(),
    revert: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.config !== undefined || v.revert !== undefined, {
    message: "harden requires a config or revert",
  });

export type SecurityHardenParams = z.infer<typeof securityHardenParamsSchema>;

/** The `config` sub-shape `security.harden` accepts (enum-only — `frame`/`referrer` are omitted, never `""`). */
export type HardenConfigInput = NonNullable<SecurityHardenParams["config"]>;

/**
 * Convert the STORED hardening config (where `frame`/`referrer` may be `""` = off)
 * into the enum-only params the connector's validator accepts: an empty `frame` /
 * `referrer` is OMITTED (absent ⇒ off, per `sanitize_config`), never sent as `""`
 * (which the closed-enum validator would reject). Booleans + `csp` (incl. `"off"`)
 * are always explicit so the whole config is replaced deterministically. Pure.
 */
export function hardeningConfigToParams(config: HardeningConfig): HardenConfigInput {
  const out: HardenConfigInput = {
    hsts: config.hsts,
    nosniff: config.nosniff,
    permissions: config.permissions,
    csp: config.csp,
  };
  if (config.frame !== "") out.frame = config.frame;
  if (config.referrer !== "") out.referrer = config.referrer;
  return out;
}

/** A non-array, non-null object — the shape the plugin requires for `settings`. */
const settingsObjectSchema = z.custom<Record<string, unknown>>(
  (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  { message: "settings must be an object" },
);

/**
 * `consent.setConfig` params — exactly one `settings` object key. The plugin's
 * `sanitize_settings()` gauntlet is the real validator; this is the console-side
 * shape check (parity with the plugin's `{ settings: stdClass }` validator).
 */
export const consentSetParamsSchema = z.object({ settings: settingsObjectSchema }).strict();

export type ConsentSetParams = z.infer<typeof consentSetParamsSchema>;

/** Client-side sanity check for the harden params — mirrors the plugin validator. */
export function validateHardenParams(params: Record<string, unknown>): boolean {
  return securityHardenParamsSchema.safeParse(params).success;
}

// ── the read/write verbs the dedicated Site Security route dispatches ──────────
/** GET verbs (read-only, `wordpress:read`). */
export const SECURITY_READ_VERBS = ["scan", "status", "consent"] as const;
export type SecurityReadVerb = (typeof SECURITY_READ_VERBS)[number];
/** POST verbs (`wordpress:write` + same-origin). `consent` here = setConfig. */
export const SECURITY_WRITE_VERBS = ["harden", "consent"] as const;
export type SecurityWriteVerb = (typeof SECURITY_WRITE_VERBS)[number];

// ── pure fusion helpers (unit-tested; no I/O) ─────────────────────────────────

/** Header verdict → posture check state. weak is a "recommended", missing a "critical". */
const HEADER_STATE_TO_CHECK: Readonly<Record<HeaderState, CheckState>> = {
  good: "good",
  weak: "recommended",
  missing: "critical",
};

/** Source of a merged posture row — wp-cli fact vs live HTTP header grade. */
export type PostureSource = "wp-cli" | "headers";

export interface MergedPostureCheck {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
  readonly source: PostureSource;
}

export interface MergedSecurityPosture {
  readonly checks: readonly MergedPostureCheck[];
  /** Blended 0–100 score. Header grade folds in ONLY when a live scan is present. */
  readonly score: number;
  /** The A–F header grade when a live scan graded headers; null otherwise. */
  readonly headerGrade: SecurityGrade | null;
  readonly counts: { readonly good: number; readonly recommended: number; readonly critical: number };
}

/** Stable, collision-resistant id fragment from a header/leak name. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** One graded HTTP header → a posture check row (source = headers). Pure. */
export function headerRowToCheck(row: SecurityHeaderRow): MergedPostureCheck {
  return {
    id: `header-${slug(row.name)}`,
    label: `${row.name} header`,
    state: HEADER_STATE_TO_CHECK[row.state],
    detail: row.value_hint ? `${row.why} (${row.value_hint})` : row.why,
    source: "headers",
  };
}

/** One information-disclosure leak → a "recommended" posture check row. Pure. */
export function leakRowToCheck(leak: SecurityLeakRow): MergedPostureCheck {
  return {
    id: `leak-${slug(leak.name)}`,
    label: `${leak.name} disclosure`,
    state: "recommended",
    detail: leak.value_hint ? `${leak.why} (${leak.value_hint})` : leak.why,
    source: "headers",
  };
}

/** True when a scan actually graded live headers (not locked, not a fetch failure). */
export function scanIsUsable(scan: SecurityScanResult | null | undefined): scan is SecurityScanResult {
  return !!scan && scan.ok === true && scan.locked !== true;
}

/**
 * Merge `security.scan`'s header grade OVER the header-blind wp-cli posture list:
 * the wp-cli checks lead, the live HTTP-header verdicts + leaks are appended, and
 * the score blends the posture score with the header score ONLY when a live scan
 * is present. A null / locked / failed scan yields the posture unchanged (the
 * surface degrades to posture-only). Immutable — never mutates the inputs.
 */
export function mergeSecurityPosture(posture: SecurityData, scan: SecurityScanResult | null): MergedSecurityPosture {
  const base: MergedPostureCheck[] = posture.checks.map((c) => ({
    id: c.id,
    label: c.label,
    state: c.state,
    detail: c.detail,
    source: "wp-cli",
  }));

  const usable = scanIsUsable(scan);
  const headerChecks: MergedPostureCheck[] = usable
    ? [...(scan.headers ?? []).map(headerRowToCheck), ...(scan.leaks ?? []).map(leakRowToCheck)]
    : [];

  const checks = [...base, ...headerChecks];
  const counts = {
    good: checks.filter((c) => c.state === "good").length,
    recommended: checks.filter((c) => c.state === "recommended").length,
    critical: checks.filter((c) => c.state === "critical").length,
  };

  const headerScore = usable && typeof scan.score === "number" ? scan.score : null;
  const score = headerScore !== null ? Math.round((posture.score + headerScore) / 2) : posture.score;
  const headerGrade = usable && scan.grade ? scan.grade : null;

  return { checks, score, headerGrade, counts };
}

/**
 * Build the `consent.setConfig` payload that flips `enabled` while PRESERVING the
 * connector's own currently-reported settings (never fabricating a config). On a
 * fresh site `current` is the connector's sanitized baseline (opt-in model, all
 * categories) — so enabling applies that GDPR-safe default, not console-invented
 * values. `saved_at` is dropped (the plugin stamps it). Default-OFF holds: nothing
 * flips `enabled` except this explicit operator action.
 */
export function consentTogglePayload(current: ConsentSettings | undefined, enabled: boolean): ConsentSetParams {
  const base: Record<string, unknown> = {};
  if (current) {
    for (const [key, value] of Object.entries(current)) {
      if (key === "saved_at") continue;
      base[key] = value;
    }
  }
  return { settings: { ...base, enabled } };
}
