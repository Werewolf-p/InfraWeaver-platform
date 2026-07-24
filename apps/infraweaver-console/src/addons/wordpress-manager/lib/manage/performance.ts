/**
 * Performance & cache fusion — the console-side TYPES + zod request validators for
 * the six signed `perf.*` / `cache.*` commands. Isomorphic (no `server-only`): the
 * API route parses requests through these schemas, the RPC registry reuses them as
 * client-side sanity checks, and the client narrows responses against these types.
 *
 * Every bound + key allow-list MIRRORS the connector's param validators in
 * `IWSL_Plugin::command_handlers()` (the `$perf_audit_params` … `$perf_settings_params`
 * closures) and the result shapes the engines return (`IWSL_Page_Cache::status()`,
 * `IWSL_Speed_Pack::settings()/status()`, `IWSL_Lazy_Load::settings()`,
 * `IWSL_Perf_Audit::build_report()`) so the two sides can never drift — a request
 * this module accepts is one the plugin's validator also accepts.
 *
 * `perf.status` is the console's SINGLE read-only composite: one signed round-trip
 * feeding the whole Performance surface (no per-panel wp-cli exec fan-out).
 */

import { z } from "zod";

// ── bounds (mirror the connector validator constants; keep in lockstep) ────────
/** `cache.purge` / `cache.warm` per-call path-list cap (and each path's max length). */
export const PURGE_PATHS_MAX = 50;
export const WARM_PATHS_MAX = 25;
export const WARM_LIMIT_MAX = 25;
export const PATH_LEN_MAX = 1024;
/** `perf.audit` row cap (IWSL_Perf_Audit::REPORT_ROWS). */
export const AUDIT_ROWS_MAX = 25;
/** `cache.configure` TTL window (seconds) + exclusion-list cap / pattern length. */
export const TTL_MIN = 600;
export const TTL_MAX = 86_400;
export const EXCLUSIONS_MAX = 50;
export const EXCLUSION_LEN_MAX = 300;
/** Speed-pack heartbeat clamp (IWSL_Speed_Pack::clamp_heartbeat window; WP accepts 15..120s). */
export const HEARTBEAT_MIN = 15;
export const HEARTBEAT_MAX = 120;
/** Lazy-load skip-first-N eager images clamp (IWSL_Lazy_Load::clamp_skip). */
export const SKIP_IMAGES_MAX = 20;

/** The ten speed-pack boolean switches + heartbeat toggles (the connector's allow-list). */
export const SPEED_PACK_SWITCHES = [
  "minify_html",
  "defer_js",
  "delay_js",
  "server_headers",
  "resource_hints",
  "remove_query_strings",
  "disable_emojis",
  "disable_embeds",
  "instant_page",
  "heartbeat_control",
  "heartbeat_disable_frontend",
] as const;
export type SpeedPackSwitch = (typeof SPEED_PACK_SWITCHES)[number];

// ── result shapes ─────────────────────────────────────────────────────────────

/** `IWSL_Page_Cache::status()` — cache posture + hit/miss counters + baked settings. */
export interface PageCacheStatus {
  readonly enabled: boolean;
  readonly dropin_present: boolean;
  readonly dropin_is_ours: boolean;
  readonly dropin_stale: boolean;
  readonly template_version: number;
  readonly wp_cache_defined: boolean;
  readonly wp_config_writable: boolean;
  readonly entries: number;
  readonly total_bytes: number;
  readonly ttl: number;
  readonly exclusions: readonly string[];
  readonly hits_today: number;
  readonly misses_today: number;
  readonly hits_7d: number;
  readonly misses_7d: number;
  readonly hit_rate: number;
  readonly hit_rate_7d: number;
}

/** `IWSL_Speed_Pack::settings()` — the ten toggles + hosts/exclusions/heartbeat. */
export interface SpeedPackSettings {
  readonly minify_html: boolean;
  readonly defer_js: boolean;
  readonly delay_js: boolean;
  readonly server_headers: boolean;
  readonly resource_hints: boolean;
  readonly remove_query_strings: boolean;
  readonly disable_emojis: boolean;
  readonly disable_embeds: boolean;
  readonly instant_page: boolean;
  readonly heartbeat_control: boolean;
  readonly heartbeat_disable_frontend: boolean;
  readonly heartbeat_frequency: number;
  readonly prefetch_hosts: readonly string[];
  readonly defer_exclusions: readonly string[];
}

/** `IWSL_Speed_Pack::status()` — managed `.htaccess` block posture. */
export interface SpeedPackStatus {
  readonly htaccess_written: boolean;
  readonly htaccess_writable: boolean;
  readonly block_present: boolean;
}

/** `IWSL_Lazy_Load::settings()`. */
export interface LazyLoadSettings {
  readonly enabled: boolean;
  readonly lazy_iframes: boolean;
  readonly skip_images: number;
}

/** The trimmed audit roll-up carried inside the `perf.status` composite. */
export interface AuditRollup {
  readonly enabled: boolean;
  readonly avg_ms: number;
  readonly total_samples: number;
  readonly slow_paths: number;
}

/** `perf.status` — the whole surface in one signed round-trip. */
export interface PerfStatusResponse {
  readonly page_cache: PageCacheStatus;
  readonly speed_pack: { readonly settings: SpeedPackSettings; readonly status: SpeedPackStatus };
  readonly lazy_load: LazyLoadSettings;
  readonly audit: AuditRollup;
}

/** One row of `IWSL_Perf_Audit::build_report()` — a measured URL with its issues. */
export interface AuditRow {
  readonly path: string;
  readonly count: number;
  readonly avg_ms: number;
  readonly max_ms: number;
  readonly last_ms: number;
  readonly avg_q: number;
  readonly max_q: number;
  readonly max_mem: number;
  readonly issues: readonly string[];
}

/** `perf.audit` — the full Load-Time Audit report (FREE feature, rows capped). */
export interface PerfAuditResponse {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly since: number;
  readonly total_samples: number;
  readonly paths_tracked: number;
  readonly overflow: number;
  readonly capped: boolean;
  readonly avg_ms: number;
  readonly slow_paths: number;
  readonly worst_path: string;
  readonly worst_avg_ms: number;
  readonly items: readonly AuditRow[];
  readonly max_paths: number;
  readonly thresholds: { readonly slow_ms: number; readonly very_slow_ms: number; readonly query_max: number };
}

/** `cache.purge` result. */
export interface CachePurgeResponse {
  readonly purged: number;
}

/** `cache.warm` result (`locked` folded on when the engine refused on the gate). */
export interface CacheWarmResponse {
  readonly warmed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly gate?: Record<string, unknown>;
}

/** `cache.configure` result — `enable()`/`disable()` echo + the effective settings. */
export interface CacheConfigureResponse {
  readonly ok: boolean;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly wp_config_written?: boolean;
  readonly manual_step?: string;
  readonly settings?: { readonly ttl: number; readonly exclusions: readonly string[]; readonly enabled: boolean };
  readonly gate?: Record<string, unknown>;
}

/** `perf.settings.set` result — one echo per sub-feature the caller touched. */
export interface PerfSettingsResponse {
  readonly lazy_load?: { readonly ok: boolean; readonly locked?: boolean; readonly reason?: string; readonly settings?: LazyLoadSettings };
  readonly speed_pack?: {
    readonly ok: boolean;
    readonly locked?: boolean;
    readonly reason?: string;
    readonly settings?: SpeedPackSettings;
    readonly server_config?: Record<string, unknown>;
  };
}

// ── request validators (parity with the connector's param closures) ────────────

const pathString = z.string().min(1).max(PATH_LEN_MAX);

/** `perf.audit` params — `{ rows? }`, strays refused (mirrors $perf_audit_params). */
export const perfAuditParamsSchema = z
  .object({ rows: z.number().int().min(1).max(AUDIT_ROWS_MAX).optional() })
  .strict();
export type PerfAuditParams = z.infer<typeof perfAuditParamsSchema>;

/** `cache.purge` params — discriminated by scope (mirrors $cache_purge_params). */
export const cachePurgeParamsSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("all") }).strict(),
  z.object({ scope: z.literal("paths"), paths: z.array(pathString).min(1).max(PURGE_PATHS_MAX) }).strict(),
]);
export type CachePurgeParams = z.infer<typeof cachePurgeParamsSchema>;

/** `cache.warm` params — `{ paths?, limit? }` (mirrors $cache_warm_params). */
export const cacheWarmParamsSchema = z
  .object({
    paths: z.array(pathString).min(1).max(WARM_PATHS_MAX).optional(),
    limit: z.number().int().min(1).max(WARM_LIMIT_MAX).optional(),
  })
  .strict();
export type CacheWarmParams = z.infer<typeof cacheWarmParamsSchema>;

/** `cache.configure` params — at least one of enabled/ttl/exclusions (mirrors $cache_configure_params). */
export const cacheConfigureParamsSchema = z
  .object({
    enabled: z.boolean().optional(),
    ttl: z.number().int().min(TTL_MIN).max(TTL_MAX).optional(),
    exclusions: z.array(z.string().max(EXCLUSION_LEN_MAX)).max(EXCLUSIONS_MAX).optional(),
  })
  .strict()
  .refine((v) => v.enabled !== undefined || v.ttl !== undefined || v.exclusions !== undefined, {
    message: "cache.configure requires at least one of enabled, ttl or exclusions",
  });
export type CacheConfigureParams = z.infer<typeof cacheConfigureParamsSchema>;

/** Lazy-load sub-object — every field optional; strays refused. */
export const lazyLoadSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    lazy_iframes: z.boolean().optional(),
    skip_images: z.number().int().min(0).max(SKIP_IMAGES_MAX).optional(),
  })
  .strict();

/** Speed-pack sub-object — only the connector's allow-listed keys; strays refused. */
export const speedPackSettingsSchema = z
  .object({
    minify_html: z.boolean().optional(),
    defer_js: z.boolean().optional(),
    delay_js: z.boolean().optional(),
    server_headers: z.boolean().optional(),
    resource_hints: z.boolean().optional(),
    remove_query_strings: z.boolean().optional(),
    disable_emojis: z.boolean().optional(),
    disable_embeds: z.boolean().optional(),
    instant_page: z.boolean().optional(),
    heartbeat_control: z.boolean().optional(),
    heartbeat_disable_frontend: z.boolean().optional(),
    heartbeat_frequency: z.number().int().min(HEARTBEAT_MIN).max(HEARTBEAT_MAX).optional(),
    prefetch_hosts: z.array(z.string().max(200)).max(20).optional(),
    defer_exclusions: z.array(z.string().max(200)).max(50).optional(),
  })
  .strict();

/** `perf.settings.set` params — lazy_load and/or speed_pack (mirrors $perf_settings_params). */
export const perfSettingsParamsSchema = z
  .object({ lazy_load: lazyLoadSettingsSchema.optional(), speed_pack: speedPackSettingsSchema.optional() })
  .strict()
  .refine((v) => v.lazy_load !== undefined || v.speed_pack !== undefined, {
    message: "perf.settings.set requires lazy_load and/or speed_pack",
  });
export type PerfSettingsParams = z.infer<typeof perfSettingsParamsSchema>;

/** The read verbs (GET) the performance route serves — one composite + the audit. */
export const PERF_READ_VERBS = ["status", "audit"] as const;
export type PerfReadVerb = (typeof PERF_READ_VERBS)[number];

/** The write verbs (POST) the performance route dispatches (one signed method per verb). */
export const PERF_WRITE_VERBS = ["purge", "warm", "configure", "settings"] as const;
export type PerfWriteVerb = (typeof PERF_WRITE_VERBS)[number];
