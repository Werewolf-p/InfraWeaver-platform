/**
 * Content / Branding / Config fusion — the console-side TYPES + zod request
 * validators for the five signed methods behind the Brand Kit card, the fused
 * Config editor, and the console Duplicate action:
 *
 *   branding.get   branding.set   config.get   config.set   content.duplicate
 *
 * Isomorphic (no `server-only`): the dedicated signed-channel API route parses
 * requests through these schemas, and the client narrows responses against these
 * types. Every field, bound, and per-key type MIRRORS the connector's own
 * validators (`IWSL_White_Label::validate_wire_params`,
 * `IWSL_Config_Editor::validate_wire_params`, `IWSL_Duplicate_Post::validate_params`)
 * so the two sides can never drift — a request this module accepts is one the
 * plugin's validator also accepts, and the engine re-checks it a second time.
 *
 * The zod schemas are the "second copy" of each allow-list; the plugin engines
 * are the first. A bug in either still fails closed because both run.
 */

import { z } from "zod";

// ── branding.get / branding.set ──────────────────────────────────────────────

/**
 * The string-valued fields the signed `branding.set` wire validator accepts —
 * mirrors `IWSL_White_Label::WIRE_STRING_FIELDS` exactly (the sanitized-settings
 * string keys). Never reorder/rename: this is the wire allow-list.
 */
export const BRANDING_WIRE_STRING_FIELDS = [
  "login_logo_url",
  "login_header_url",
  "login_header_text",
  "login_message",
  "admin_footer_text",
  "brand_name",
  "accent_color",
  "email_logo_url",
] as const;
export type BrandingStringField = (typeof BRANDING_WIRE_STRING_FIELDS)[number];

/** Bool-valued `branding.set` fields — mirrors `IWSL_White_Label::WIRE_BOOL_FIELDS`. */
export const BRANDING_WIRE_BOOL_FIELDS = ["hide_wp_logo", "apply_to_email", "apply_to_maintenance"] as const;
export type BrandingBoolField = (typeof BRANDING_WIRE_BOOL_FIELDS)[number];

/** Total UTF-8 byte ceiling on all string values in one payload — mirrors `WIRE_MAX_BYTES`. */
export const BRANDING_WIRE_MAX_BYTES = 8192;

/** Strict `#rrggbb` accent — advisory client mirror of `IWSL_White_Label::COLOR_RE`. */
export const BRANDING_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The full sanitized settings map `branding.get` returns (`IWSL_White_Label::settings()`). */
export interface BrandingSettings {
  readonly login_logo_url: string;
  readonly login_header_url: string;
  readonly login_header_text: string;
  readonly login_message: string;
  readonly admin_footer_text: string;
  readonly hide_wp_logo: boolean;
  readonly brand_name: string;
  readonly accent_color: string;
  readonly email_logo_url: string;
  readonly apply_to_email: boolean;
  readonly apply_to_maintenance: boolean;
  readonly saved_at: number;
}

/** One registered brand surface's metadata (`IWSL_Brand_Surface::id/label/hooks`). */
export interface BrandingSurface {
  readonly id: string;
  readonly label: string;
  readonly hooks: readonly string[];
}

/**
 * The gate descriptor `IWSL_Entitlements::evaluate('white_label')` returns.
 * Best-effort typing — the plugin is the source of truth; the UI reads only these
 * fields and treats the rest opaquely. Safe when locked: `branding.get` is a pure
 * read even for an unentitled site, so the console can render the locked state.
 */
export interface BrandingGate {
  readonly unlocked: boolean;
  readonly feature?: string;
  readonly linked?: boolean;
  readonly heartbeat_fresh?: boolean;
  readonly plus?: boolean;
  readonly state?: string;
  readonly reasons?: readonly string[];
  readonly tier?: string;
}

export interface BrandingGetResponse {
  readonly gate: BrandingGate;
  readonly settings: BrandingSettings;
  readonly surfaces: Readonly<Record<string, BrandingSurface>>;
}

/** `branding.set` echo: the stored map on success, or a verbatim refusal reason. */
export type BrandingSetResult =
  | { readonly ok: true; readonly settings: BrandingSettings }
  | { readonly ok: false; readonly reason: string };

/**
 * UTF-8 byte length of a string — the parity metric for PHP `strlen()`, which the
 * connector's `WIRE_MAX_BYTES` bound counts. Pure and isomorphic (no `TextEncoder`
 * / `Buffer`, so it runs identically in the browser, Node, and the jest sandbox);
 * handles surrogate pairs as 4 bytes.
 */
export function utf8ByteLength(str: string): number {
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // high surrogate — a 4-byte code point; skip its low surrogate.
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

const brandingStringField = z.string().max(BRANDING_WIRE_MAX_BYTES);

/**
 * `branding.set` params — `{ settings: { <allow-listed field>: string|bool } }` and
 * nothing else. Strays refused (`.strict()`), and the total UTF-8 byte size of all
 * string values is bounded to `BRANDING_WIRE_MAX_BYTES`, mirroring
 * `IWSL_White_Label::validate_wire_params`. No sanitization here — `save_settings()`
 * runs the identical, authoritative save-time gauntlet on the far side.
 */
export const brandingSettingsSchema = z
  .object({
    login_logo_url: brandingStringField.optional(),
    login_header_url: brandingStringField.optional(),
    login_header_text: brandingStringField.optional(),
    login_message: brandingStringField.optional(),
    admin_footer_text: brandingStringField.optional(),
    brand_name: brandingStringField.optional(),
    accent_color: brandingStringField.optional(),
    email_logo_url: brandingStringField.optional(),
    hide_wp_logo: z.boolean().optional(),
    apply_to_email: z.boolean().optional(),
    apply_to_maintenance: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    let bytes = 0;
    for (const field of BRANDING_WIRE_STRING_FIELDS) {
      const value = (val as Record<string, unknown>)[field];
      if (typeof value === "string") bytes += utf8ByteLength(value);
    }
    if (bytes > BRANDING_WIRE_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Branding payload exceeds the byte limit" });
    }
  });

export const brandingSetParamsSchema = z.object({ settings: brandingSettingsSchema }).strict();
export type BrandingSetParams = z.infer<typeof brandingSetParamsSchema>;

// ── config.get / config.set ──────────────────────────────────────────────────

export type ConfigType = "size" | "int" | "int_or_false" | "bool";
export type ConfigGroup = "wpconfig" | "userini";

export interface ConfigAllowlistEntry {
  readonly label: string;
  readonly group: ConfigGroup;
  readonly type: ConfigType;
  readonly min?: number;
}

/**
 * The console-side mirror of `IWSL_Config_Editor::allowlist()` — keys, labels,
 * groups and per-key types. The connector returns its own authoritative allowlist
 * in `config.get`; this local copy drives the wire validator and the UI risk
 * labels. Keep in lockstep with the connector: it never grows here without growing
 * there (the plan freezes both together).
 */
export const CONFIG_ALLOWLIST: Readonly<Record<string, ConfigAllowlistEntry>> = {
  WP_MEMORY_LIMIT: { label: "Memory limit", group: "wpconfig", type: "size" },
  WP_MAX_MEMORY_LIMIT: { label: "Max memory limit (admin)", group: "wpconfig", type: "size" },
  WP_POST_REVISIONS: { label: "Post revisions", group: "wpconfig", type: "int_or_false", min: 0 },
  EMPTY_TRASH_DAYS: { label: "Empty trash after (days)", group: "wpconfig", type: "int", min: 0 },
  AUTOSAVE_INTERVAL: { label: "Autosave interval (seconds)", group: "wpconfig", type: "int", min: 10 },
  WP_DEBUG: { label: "Debug mode", group: "wpconfig", type: "bool" },
  WP_DEBUG_LOG: { label: "Debug logging", group: "wpconfig", type: "bool" },
  WP_DEBUG_DISPLAY: { label: "Display debug errors", group: "wpconfig", type: "bool" },
  DISALLOW_FILE_EDIT: { label: "Disallow theme/plugin file editing", group: "wpconfig", type: "bool" },
  upload_max_filesize: { label: "Max upload file size", group: "userini", type: "size" },
  post_max_size: { label: "Max POST size", group: "userini", type: "size" },
  max_execution_time: { label: "Max execution time (seconds)", group: "userini", type: "int", min: 0 },
} as const;

export type ConfigKey = keyof typeof CONFIG_ALLOWLIST;

/** The effective current value of every allow-listed key (`IWSL_Config_Editor::current()`). */
export type ConfigCurrent = Readonly<Record<string, string | boolean>>;

export interface ConfigGetResponse {
  readonly allowlist: Readonly<Record<string, ConfigAllowlistEntry>>;
  readonly current: ConfigCurrent;
  /** What the managed block last WROTE (distinct from live effective) — honest configured-vs-effective. */
  readonly configured: Readonly<Record<string, string>>;
  readonly mechanism: string;
  readonly writable: { readonly wp_config: boolean; readonly php_limits: boolean };
}

/** Full `IWSL_Config_Editor::apply()` result — rendered verbatim (applied/skipped/manual/effective). */
export interface ConfigApplyResult {
  readonly ok: boolean;
  readonly applied: readonly string[];
  readonly skipped: Readonly<Record<string, string>>;
  readonly wp_config_writable: boolean;
  readonly user_ini_writable: boolean;
  readonly php_limits_mechanism: string;
  readonly php_limits_writable: boolean;
  /** Live effective ini_get() values after a limits write — only refresh next request. */
  readonly effective?: Readonly<Record<string, string>>;
  readonly notes?: readonly string[];
  /** Guidance when a target is unwritable — rendered as instruction, never as success. */
  readonly manual_step?: string;
}

// per-type value shapes — parity with `IWSL_Config_Editor::wire_value_ok`.
const sizeVal = z.string().regex(/^\d+[KMG]?$/i);
// int: a non-negative integer, or the string form of one (bounds re-checked in apply()).
const intVal = z.union([z.number().int().min(0), z.string().regex(/^\d+$/)]);
// int_or_false: false, '', 'false' (case-insensitive), a non-negative int, or its string form.
const intOrFalseVal = z.union([
  z.literal(false),
  z.number().int().min(0),
  z.string().regex(/^(?:\d+|false|)$/i),
]);
const boolVal = z.boolean();

const configValuesSchema = z
  .object({
    WP_MEMORY_LIMIT: sizeVal.optional(),
    WP_MAX_MEMORY_LIMIT: sizeVal.optional(),
    WP_POST_REVISIONS: intOrFalseVal.optional(),
    EMPTY_TRASH_DAYS: intVal.optional(),
    AUTOSAVE_INTERVAL: intVal.optional(),
    WP_DEBUG: boolVal.optional(),
    WP_DEBUG_LOG: boolVal.optional(),
    WP_DEBUG_DISPLAY: boolVal.optional(),
    DISALLOW_FILE_EDIT: boolVal.optional(),
    upload_max_filesize: sizeVal.optional(),
    post_max_size: sizeVal.optional(),
    max_execution_time: intVal.optional(),
  })
  .strict();

/**
 * `config.set` params — `{ values: { <allowlist key>: scalar } }` and nothing else.
 * Refuses a stray top-level key, a values key outside the allow-list, or a value
 * whose shape does not match its allow-listed type. Mirrors
 * `IWSL_Config_Editor::validate_wire_params`; `apply()` enforces it again.
 */
export const configSetParamsSchema = z.object({ values: configValuesSchema }).strict();
export type ConfigSetParams = z.infer<typeof configSetParamsSchema>;

/** Per-key risk annotations the Config editor surfaces (B1). Never widens the allow-list. */
export const CONFIG_RISK: Readonly<Record<string, string>> = {
  WP_DEBUG_DISPLAY: "Shows PHP errors to visitors. Only enable briefly while diagnosing — never on a live site.",
  DISALLOW_FILE_EDIT: "Turning this OFF re-opens the theme/plugin file editor in wp-admin — a common attack surface.",
};

/** Keys whose ENABLE (true) on a live site should require an explicit confirm (B1). */
export const CONFIG_CONFIRM_ON_ENABLE: readonly ConfigKey[] = ["WP_DEBUG_DISPLAY"];

// ── content.duplicate ────────────────────────────────────────────────────────

/** `content.duplicate` params — `{ post_id }` and nothing else (`IWSL_Duplicate_Post::validate_params`). */
export const contentDuplicateParamsSchema = z.object({ post_id: z.number().int().positive() }).strict();
export type ContentDuplicateParams = z.infer<typeof contentDuplicateParamsSchema>;

/** `content.duplicate` result — the new draft ids on success, or a verbatim refusal reason. */
export type ContentDuplicateResult =
  | {
      readonly ok: true;
      readonly source_id: number;
      readonly new_id: number;
      readonly terms_copied: number;
      readonly meta_copied: number;
    }
  | { readonly ok: false; readonly reason: string };

// ── route verb vocabularies (one signed method per verb) ──────────────────────

/** GET read verbs the dedicated content-branding route serves. */
export const CONTENT_BRANDING_READ_VERBS = ["branding", "config"] as const;
export type ContentBrandingReadVerb = (typeof CONTENT_BRANDING_READ_VERBS)[number];

/** POST write verbs the dedicated route dispatches (signed method per verb). */
export const CONTENT_BRANDING_WRITE_VERBS = ["branding-set", "config-set", "content-duplicate"] as const;
export type ContentBrandingWriteVerb = (typeof CONTENT_BRANDING_WRITE_VERBS)[number];
