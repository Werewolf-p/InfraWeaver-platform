/**
 * IWSL RPC method registry — the console-side catalog of the signed commands the
 * Connector allow-lists (§6/§7), plus `callRpc`, the typed funnel every managed
 * op routes through on top of the existing signed-command transport
 * (`dispatchSignedCommand`).
 *
 * Phase 0 of the RPC layer: no wire change. The bytes signed and delivered are
 * identical to the pre-registry call sites — `callRpc` forwards the same method
 * string and the same params object to the transport, unchanged. What this adds
 * is one typed definition point for the six methods that mirrors the plugin's
 * `IWSL_Plugin::allowed_methods()` allow-list, so the two sides can be kept in
 * lockstep and future methods have a single home.
 *
 * Deliberately isomorphic (no `server-only`): it holds no transport, only the
 * method catalog and the pass-through. The transport — which IS server-only —
 * is injected by `iwsl-managed-ops`.
 */

import { validateEntitlementsParams } from "../entitlements";
import {
  mediaFolderParamsSchema,
  mediaListParamsSchema,
  mediaOffloadParamsSchema,
  mediaOptimizeParamsSchema,
  mediaRestoreParamsSchema,
  type MediaFolderParams,
  type MediaListParams,
  type MediaListResponse,
  type MediaOffloadParams,
  type MediaOptimizeParams,
  type MediaRestoreParams,
  type MediaStatusResponse,
  type MediaTreeResponse,
} from "../manage/media";
import {
  emailConfigSetParamsSchema,
  emailTestParamsSchema,
  type EmailConfigSetParams,
  type EmailConfigSetResult,
  type EmailConnectorConfig,
  type EmailLogClearResult,
  type EmailLogResponse,
  type EmailTestParams,
  type EmailTestResult,
} from "../manage/email";
import {
  linkScanParamsSchema,
  maintenanceSetParamsSchema,
  redirectCreateParamsSchema,
  redirectDeleteParamsSchema,
  redirectImportParamsSchema,
  redirectTogglesParamsSchema,
  type LinkScanParams,
  type LinkScanSummary,
  type MaintenanceSetParams,
  type MaintenanceSetResult,
  type RedirectCreateParams,
  type RedirectDeleteParams,
  type RedirectImportParams,
  type RedirectImportResult,
  type RedirectMutationResult,
  type RedirectTogglesParams,
  type RedirectTogglesResult,
  type RedirectsListResult,
  type SiteHealthSnapshot,
} from "../manage/site-health";
import {
  consentSetParamsSchema,
  validateHardenParams,
  type ConsentConfigResponse,
  type ConsentSetParams,
  type ConsentSetResult,
  type ProtectionStatusResponse,
  type SecurityHardenParams,
  type SecurityHardenResult,
  type SecurityScanResult,
} from "../manage/security-consent";
import {
  dbCleanupParamsSchema,
  dbScheduleParamsSchema,
  type DbAnalyzeResponse,
  type DbCleanupParams,
  type DbCleanupResponse,
  type DbScheduleParams,
  type DbScheduleResponse,
} from "../manage/database";
import {
  brandingSetParamsSchema,
  configSetParamsSchema,
  contentDuplicateParamsSchema,
  type BrandingGetResponse,
  type BrandingSetParams,
  type BrandingSetResult,
  type ConfigApplyResult,
  type ConfigGetResponse,
  type ConfigSetParams,
  type ContentDuplicateParams,
  type ContentDuplicateResult,
} from "../manage/content-branding";
import {
  seoAltBackfillParamsSchema,
  seoAuditParamsSchema,
  seoFixParamsSchema,
  type SeoAltBackfillParams,
  type SeoAltBackfillResponse,
  type SeoAuditParams,
  type SeoAuditRunResult,
  type SeoFixApplyResponse,
  type SeoFixParams,
  type SeoStatusResponse,
} from "../manage/seo";
import {
  activityLogParamsSchema,
  statsSummaryParamsSchema,
  statsTimeseriesParamsSchema,
  type ActivityLogParams,
  type ActivityLogResponse,
  type StatsSummaryParams,
  type StatsSummaryResponse,
  type StatsTimeseriesParams,
  type StatsTimeseriesResponse,
} from "../manage/insights";
import {
  cacheConfigureParamsSchema,
  cachePurgeParamsSchema,
  cacheWarmParamsSchema,
  perfAuditParamsSchema,
  perfSettingsParamsSchema,
  type CacheConfigureParams,
  type CacheConfigureResponse,
  type CachePurgeParams,
  type CachePurgeResponse,
  type CacheWarmParams,
  type CacheWarmResponse,
  type PerfAuditParams,
  type PerfAuditResponse,
  type PerfSettingsParams,
  type PerfSettingsResponse,
  type PerfStatusResponse,
} from "../manage/performance";

/** Signed-command methods the Connector allow-lists (§7). Wire strings — never rename. */
export type RpcMethod =
  | "health.check"
  | "debug.status"
  | "metrics.snapshot"
  | "key.rotate.self"
  | "key.rotate.confirm"
  | "key.rotate.abort"
  | "site.deactivate"
  | "link.purge"
  | "entitlements.set"
  // ── media fusion (§ media) — the flagship fused Media Explorer's read + act methods.
  | "media.list"
  | "media.tree"
  | "media.status"
  | "media.optimize"
  | "media.offload"
  | "media.restore"
  | "media.folder"
  // ── performance & cache fusion (§ perf) — one composite read + audit + cache/optimization writes.
  | "perf.status"
  | "perf.audit"
  | "cache.purge"
  | "cache.warm"
  | "cache.configure"
  | "perf.settings.set"
  // ── SEO console (§ seo) — engine-aware score, console-run audit, one-click fixes.
  | "seo.status"
  | "seo.audit.run"
  | "seo.alt.backfill"
  | "seo.fix.apply"
  // ── analytics/insights (§ analytics) — three READ-ONLY methods behind the
  // console's Insights surface (traffic summary, daily/hourly series, admin
  // activity trail). Aggregates only; every result is a signed { locked, gate }
  // when the site isn't entitled.
  | "stats.summary"
  | "stats.timeseries"
  | "activity.log"
  // ── content / branding / config fusion (content-branding domain) ──
  | "branding.get"
  | "branding.set"
  | "config.get"
  | "config.set"
  | "content.duplicate"
  // ── database fusion (§ database) — the fused Database cockpit's read + act methods.
  | "db.analyze"
  | "db.cleanup"
  | "db.schedule"
  // ── Site Security / Consent / Protection (§ security) — the fused Site Security surface.
  | "security.scan"
  | "security.harden"
  | "consent.getConfig"
  | "consent.setConfig"
  | "protection.status"
  // ── site-health (§ site-health) — one bounded aggregate + redirect/scan/
  // maintenance detail reads & gated mutations. Every runner delegates to an
  // engine whose STATEMENT-1 entitlement gate is authoritative.
  | "sitehealth.snapshot"
  | "links.scan"
  | "redirects.list"
  | "redirects.create"
  | "redirects.delete"
  | "redirects.import"
  | "redirects.set_toggles"
  | "maintenance.set"
  // ── email delivery (§ email) — the console's window onto the connector's own SMTP.
  | "email.config.get"
  | "email.config.set"
  | "email.test"
  | "email.log.get"
  | "email.log.clear";

/** Params each method carries on the wire. `Record<string, never>` = no params (§6.3). */
export interface RpcParams {
  "health.check": Record<string, never>;
  "debug.status": Record<string, never>;
  "metrics.snapshot": Record<string, never>;
  "key.rotate.self": { rotation_id: string; new_kid?: number };
  "key.rotate.confirm": { rotation_id: string };
  "key.rotate.abort": { rotation_id: string };
  "site.deactivate": Record<string, never>;
  "link.purge": Record<string, never>;
  /** Paid-feature entitlements — a console-authoritative boolean flag map. */
  "entitlements.set": { entitlements: Record<string, boolean> };
  // ── media fusion — params mirror IWSL_Media_Library's validators exactly.
  "media.list": MediaListParams;
  "media.tree": Record<string, never>;
  "media.status": Record<string, never>;
  "media.optimize": MediaOptimizeParams;
  "media.offload": MediaOffloadParams;
  "media.restore": MediaRestoreParams;
  "media.folder": MediaFolderParams;
  // ── performance & cache — params mirror the connector's validator closures exactly.
  "perf.status": Record<string, never>;
  "perf.audit": PerfAuditParams;
  "cache.purge": CachePurgeParams;
  "cache.warm": CacheWarmParams;
  "cache.configure": CacheConfigureParams;
  "perf.settings.set": PerfSettingsParams;
  // ── SEO console — params mirror IWSL_SEO_Console's validators exactly.
  /** `seo.status` is a no-param safe read (counts only). */
  "seo.status": Record<string, never>;
  "seo.audit.run": SeoAuditParams;
  "seo.alt.backfill": SeoAltBackfillParams;
  "seo.fix.apply": SeoFixParams;
  // ── insights — params mirror IWSL_Statistics / IWSL_Activity_Log validators.
  "stats.summary": StatsSummaryParams;
  "stats.timeseries": StatsTimeseriesParams;
  "activity.log": ActivityLogParams;
  // ── content / branding / config — params mirror the connector's wire validators.
  "branding.get": Record<string, never>;
  "branding.set": BrandingSetParams;
  "config.get": Record<string, never>;
  "config.set": ConfigSetParams;
  "content.duplicate": ContentDuplicateParams;
  // ── database fusion — params mirror the plugin's db.* validators exactly.
  "db.analyze": Record<string, never>;
  "db.cleanup": DbCleanupParams;
  "db.schedule": DbScheduleParams;
  // ── Site Security — params mirror IWSL_Security_Headers / IWSL_Cookie_Consent validators.
  "security.scan": Record<string, never>;
  /** Closed key/enum set — never a free-form header name or value. */
  "security.harden": SecurityHardenParams;
  "consent.getConfig": Record<string, never>;
  "consent.setConfig": ConsentSetParams;
  "protection.status": Record<string, never>;
  // ── site-health — params mirror the plugin's shape validators exactly.
  "sitehealth.snapshot": Record<string, never>;
  "links.scan": LinkScanParams;
  "redirects.list": Record<string, never>;
  "redirects.create": RedirectCreateParams;
  "redirects.delete": RedirectDeleteParams;
  "redirects.import": RedirectImportParams;
  "redirects.set_toggles": RedirectTogglesParams;
  "maintenance.set": MaintenanceSetParams;
  // ── email — reads carry no params; only config.set/test carry a (write-only) body.
  "email.config.get": Record<string, never>;
  "email.config.set": EmailConfigSetParams;
  "email.test": EmailTestParams;
  "email.log.get": Record<string, never>;
  "email.log.clear": Record<string, never>;
}

/**
 * Numeric/scalar telemetry the plugin returns for `metrics.snapshot` — a
 * gauge-shaped projection of link state (see IWSL_Plugin::metrics_snapshot).
 * Best-effort typing; the exporter still narrows each field before rendering.
 */
export interface ConnectorMetricsResult {
  /** Running Connector version (→ `iwsl_connector_info` label). */
  plugin: string;
  /** PHP version the site runs (→ info label). */
  php: string;
  /** WordPress core version, or null off a real WP context (→ info label). */
  wp: string | null;
  /** Plugin's own clock in unix ms — for scrape-side skew detection. */
  time_ms: number;
  /** libsodium available for signing/verification (0/1). */
  sodium: 0 | 1;
  wp_kid: number;
  iw_kid: number;
  wp_epoch_floor: number;
  iw_epoch_floor: number;
  /** Highest command seq the link has committed (§6.3 replay watermark). */
  last_seq: number;
  /** Live replay-nonce cache size. */
  nonce_cache: number;
  /** A key rotation is prepared-but-unconfirmed (0/1). */
  rotation_pending: 0 | 1;
  /** Unix seconds of the last signing-key reroll, 0 if never (§8). */
  last_reroll_at: number;
  /** Whether that last reroll confirmed (1) or aborted/failed (0). */
  last_reroll_ok: 0 | 1;
}

/**
 * Verified `result` payload each method returns. Best-effort typing — the plugin
 * is the source of truth, so callers still narrow `CommandReply.result` before
 * trusting a field.
 */
export interface RpcResult {
  "health.check": {
    status: string;
    php: string;
    plugin: string;
    kid: number;
    seq: number;
    /** §5 — the site's own live canonical URL, for clone/identity-crisis detection. */
    site_url?: string;
    /** §8 — last signing-key reroll outcome (unix seconds); absent before first reroll. */
    last_reroll?: { at: number; kid: number; ok: boolean; reason?: string };
  };
  "debug.status": Record<string, unknown>;
  "metrics.snapshot": ConnectorMetricsResult;
  "key.rotate.self": { new_wp_pk: string } | { reason: string };
  "key.rotate.confirm": Record<string, never> | { reason: string };
  "key.rotate.abort": Record<string, never>;
  "site.deactivate": { deactivated: true };
  /** §12.6 delete — the plugin scrubbed all `iwsl_*` enrollment state. */
  "link.purge": { purged: true };
  /** The plugin echoes back the stored flag map it applied. */
  "entitlements.set": { entitlements: Record<string, boolean> };
  // ── media fusion — read-model + bulk-run results (the plugin is the source of truth).
  "media.list": MediaListResponse;
  "media.tree": MediaTreeResponse;
  "media.status": MediaStatusResponse;
  /** One bounded optimize batch; `result` carries the optimizer run report (`partial` etc.). */
  "media.optimize": { locked: boolean; result?: Record<string, unknown>; gate?: Record<string, unknown> };
  /** One bounded offload/un-offload batch. */
  "media.offload": { locked: boolean; result?: Record<string, unknown>; gate?: Record<string, unknown> };
  /** Restore/bring-back — per-id results + a summary roll-up. */
  "media.restore": {
    locked: boolean;
    op?: "restore";
    results?: ReadonlyArray<{ id: number; ok: boolean; reason?: string }>;
    summary?: { total: number; ok: number; failed: number };
    gate?: Record<string, unknown>;
  };
  /** Terms-only folder mutation echo. */
  "media.folder": { locked: boolean; op?: string; result?: Record<string, unknown>; gate?: Record<string, unknown> };
  // ── performance & cache — the plugin is the source of truth for every shape.
  "perf.status": PerfStatusResponse;
  "perf.audit": PerfAuditResponse;
  "cache.purge": CachePurgeResponse;
  "cache.warm": CacheWarmResponse;
  "cache.configure": CacheConfigureResponse;
  "perf.settings.set": PerfSettingsResponse;
  // ── SEO console — read-model + gated-run results (the plugin is the source of truth).
  /** Engine-aware, counts-only SEO snapshot (safe read; per-section locked markers). */
  "seo.status": SeoStatusResponse;
  /** One bounded audit run (or the structured `{ locked, gate }` upsell). */
  "seo.audit.run": SeoAuditRunResult;
  /** One bounded alt-text backfill batch (dry-run by default; or locked). */
  "seo.alt.backfill": SeoAltBackfillResponse;
  /** One allow-listed meta fix echoed back (or locked / invalid-params). */
  "seo.fix.apply": SeoFixApplyResponse;
  // ── insights — compact aggregate projections (or a signed { locked, gate }).
  "stats.summary": StatsSummaryResponse;
  "stats.timeseries": StatsTimeseriesResponse;
  "activity.log": ActivityLogResponse;
  // ── content / branding / config — the plugin is the source of truth.
  /** Read-only, safe when locked: the gate + full settings + surface metadata. */
  "branding.get": BrandingGetResponse;
  /** `{ ok:true, settings }` on save, or `{ ok:false, reason }` (e.g. entitlement-locked). */
  "branding.set": BrandingSetResult;
  /** Allow-list + effective current + last-written configured + mechanism + writability. */
  "config.get": ConfigGetResponse;
  /** Full apply() report — applied/skipped/manual_step/effective, rendered verbatim. */
  "config.set": ConfigApplyResult;
  /** New draft ids on success, or a verbatim refusal reason (entitlement-locked/unknown-post). */
  "content.duplicate": ContentDuplicateResult;
  // ── database fusion — the read-model + bounded run summaries (plugin is source of truth).
  "db.analyze": DbAnalyzeResponse;
  "db.cleanup": DbCleanupResponse;
  "db.schedule": DbScheduleResponse;
  // ── Site Security — read grades/status + closed-set writes (plugin is source of truth).
  "security.scan": SecurityScanResult;
  "security.harden": SecurityHardenResult;
  "consent.getConfig": ConsentConfigResponse;
  "consent.setConfig": ConsentSetResult;
  "protection.status": ProtectionStatusResponse;
  // ── site-health — the aggregate read + detail reads + gated mutation echoes.
  "sitehealth.snapshot": SiteHealthSnapshot;
  /** The immutable scan summary (now incl. `broken_images[]`), or a locked/refusal marker. */
  "links.scan": LinkScanSummary;
  "redirects.list": RedirectsListResult;
  "redirects.create": RedirectMutationResult;
  "redirects.delete": RedirectMutationResult;
  "redirects.import": RedirectImportResult;
  "redirects.set_toggles": RedirectTogglesResult;
  "maintenance.set": MaintenanceSetResult;
  // ── email — a secret NEVER appears in any of these read/write results.
  "email.config.get": EmailConnectorConfig;
  "email.config.set": EmailConfigSetResult;
  "email.test": EmailTestResult;
  "email.log.get": EmailLogResponse;
  "email.log.clear": EmailLogClearResult;
}

/** Client-side sanity check for a method's params — mirrors the plugin allow-list validator. */
export type RpcParamsValidator = (params: Record<string, unknown>) => boolean;

export interface RpcMethodSpec {
  /** True when the method carries params; false = wire params must be empty (§6.3). */
  readonly hasParams: boolean;
  /** True when `params` is well-formed for this method (parity with the plugin's validator). */
  readonly validate: RpcParamsValidator;
}

const noParams: RpcParamsValidator = (params) => Object.keys(params).length === 0;

/**
 * Mirror of the plugin's shared `$rotation_params` closure: a non-empty
 * `rotation_id`, an optional integer `new_kid`, and no other keys.
 */
const rotationParams: RpcParamsValidator = (params) =>
  typeof params.rotation_id === "string" &&
  params.rotation_id.length > 0 &&
  (params.new_kid === undefined || Number.isInteger(params.new_kid)) &&
  Object.keys(params).every((key) => key === "rotation_id" || key === "new_kid");

/**
 * The current signed commands. Single source of truth for the console side; the
 * ordering matches `IWSL_Plugin::allowed_methods()` for easy cross-reading.
 */
export const RPC_REGISTRY: Record<RpcMethod, RpcMethodSpec> = {
  "health.check": { hasParams: false, validate: noParams },
  "debug.status": { hasParams: false, validate: noParams },
  "metrics.snapshot": { hasParams: false, validate: noParams },
  "key.rotate.self": { hasParams: true, validate: rotationParams },
  "key.rotate.confirm": { hasParams: true, validate: rotationParams },
  "key.rotate.abort": { hasParams: true, validate: rotationParams },
  "site.deactivate": { hasParams: false, validate: noParams },
  "link.purge": { hasParams: false, validate: noParams },
  // Paid-feature entitlements — validator mirrors the plugin's allow-list check.
  "entitlements.set": { hasParams: true, validate: validateEntitlementsParams },
  // Media fusion — validators reuse the isomorphic zod schemas that mirror the
  // connector's IWSL_Media_Library validators, so the two sides can never drift.
  "media.list": { hasParams: true, validate: (p) => mediaListParamsSchema.safeParse(p).success },
  "media.tree": { hasParams: false, validate: noParams },
  "media.status": { hasParams: false, validate: noParams },
  "media.optimize": { hasParams: true, validate: (p) => mediaOptimizeParamsSchema.safeParse(p).success },
  "media.offload": { hasParams: true, validate: (p) => mediaOffloadParamsSchema.safeParse(p).success },
  "media.restore": { hasParams: true, validate: (p) => mediaRestoreParamsSchema.safeParse(p).success },
  "media.folder": { hasParams: true, validate: (p) => mediaFolderParamsSchema.safeParse(p).success },
  // Performance & cache — validators reuse the isomorphic zod schemas that mirror
  // the connector's param closures, so the two sides can never drift.
  "perf.status": { hasParams: false, validate: noParams },
  "perf.audit": { hasParams: true, validate: (p) => perfAuditParamsSchema.safeParse(p).success },
  "cache.purge": { hasParams: true, validate: (p) => cachePurgeParamsSchema.safeParse(p).success },
  "cache.warm": { hasParams: true, validate: (p) => cacheWarmParamsSchema.safeParse(p).success },
  "cache.configure": { hasParams: true, validate: (p) => cacheConfigureParamsSchema.safeParse(p).success },
  "perf.settings.set": { hasParams: true, validate: (p) => perfSettingsParamsSchema.safeParse(p).success },
  // SEO console — validators reuse the isomorphic zod schemas that mirror the
  // connector's IWSL_SEO_Console validators, so the two sides can never drift.
  "seo.status": { hasParams: false, validate: noParams },
  "seo.audit.run": { hasParams: true, validate: (p) => seoAuditParamsSchema.safeParse(p).success },
  "seo.alt.backfill": { hasParams: true, validate: (p) => seoAltBackfillParamsSchema.safeParse(p).success },
  "seo.fix.apply": { hasParams: true, validate: (p) => seoFixParamsSchema.safeParse(p).success },
  // Insights — validators reuse the isomorphic zod schemas that mirror the
  // connector's IWSL_Statistics / IWSL_Activity_Log validators (params optional,
  // so an empty object also passes — the plugin defaults the range/days/limit).
  "stats.summary": { hasParams: true, validate: (p) => statsSummaryParamsSchema.safeParse(p).success },
  "stats.timeseries": { hasParams: true, validate: (p) => statsTimeseriesParamsSchema.safeParse(p).success },
  "activity.log": { hasParams: true, validate: (p) => activityLogParamsSchema.safeParse(p).success },
  // Content / branding / config — validators reuse the isomorphic zod schemas that
  // mirror the connector's wire validators, so verifier and console can never drift.
  "branding.get": { hasParams: false, validate: noParams },
  "branding.set": { hasParams: true, validate: (p) => brandingSetParamsSchema.safeParse(p).success },
  "config.get": { hasParams: false, validate: noParams },
  "config.set": { hasParams: true, validate: (p) => configSetParamsSchema.safeParse(p).success },
  "content.duplicate": { hasParams: true, validate: (p) => contentDuplicateParamsSchema.safeParse(p).success },
  // Database fusion — db.analyze is paramless; the two write validators reuse the
  // isomorphic zod schemas that mirror the plugin's db.cleanup / db.schedule
  // validators (dry_run must be a real boolean; frequency clamped), so the two
  // sides can never drift.
  "db.analyze": { hasParams: false, validate: noParams },
  "db.cleanup": { hasParams: true, validate: (p) => dbCleanupParamsSchema.safeParse(p).success },
  "db.schedule": { hasParams: true, validate: (p) => dbScheduleParamsSchema.safeParse(p).success },
  // Site Security — read trio takes no params; harden is the closed-key/enum validator
  // (the load-bearing one — parity with IWSL_Security_Headers::validate_params);
  // consent.setConfig requires exactly one `settings` object key.
  "security.scan": { hasParams: false, validate: noParams },
  "security.harden": { hasParams: true, validate: validateHardenParams },
  "consent.getConfig": { hasParams: false, validate: noParams },
  "consent.setConfig": { hasParams: true, validate: (p) => consentSetParamsSchema.safeParse(p).success },
  "protection.status": { hasParams: false, validate: noParams },
  // Site-health — validators reuse the isomorphic zod schemas that mirror the
  // connector's shape validators, so the two allow-lists can never drift.
  "sitehealth.snapshot": { hasParams: false, validate: noParams },
  "links.scan": { hasParams: true, validate: (p) => linkScanParamsSchema.safeParse(p).success },
  "redirects.list": { hasParams: false, validate: noParams },
  "redirects.create": { hasParams: true, validate: (p) => redirectCreateParamsSchema.safeParse(p).success },
  "redirects.delete": { hasParams: true, validate: (p) => redirectDeleteParamsSchema.safeParse(p).success },
  "redirects.import": { hasParams: true, validate: (p) => redirectImportParamsSchema.safeParse(p).success },
  "redirects.set_toggles": { hasParams: true, validate: (p) => redirectTogglesParamsSchema.safeParse(p).success },
  "maintenance.set": { hasParams: true, validate: (p) => maintenanceSetParamsSchema.safeParse(p).success },
  // Email — read/clear carry no params; config.set/test validators reuse the
  // isomorphic zod schemas that mirror the plugin's wire validators, so the two
  // sides can never drift. The write-only password never rides a read method.
  "email.config.get": { hasParams: false, validate: noParams },
  "email.config.set": { hasParams: true, validate: (p) => emailConfigSetParamsSchema.safeParse(p).success },
  "email.test": { hasParams: true, validate: (p) => emailTestParamsSchema.safeParse(p).success },
  "email.log.get": { hasParams: false, validate: noParams },
  "email.log.clear": { hasParams: false, validate: noParams },
};

/** The allow-listed method names, in registry order. */
export const RPC_METHODS = Object.keys(RPC_REGISTRY) as RpcMethod[];

/** Verified reply from one signed command — the shape `dispatchSignedCommand` returns. */
export interface CommandReply {
  /** The plugin's verified `ok` verdict for the command. */
  ok: boolean;
  /** WP key epoch that signed the (verified) response. */
  kid: number;
  result: Record<string, unknown>;
  roundtripMs: number;
  /** Set when the plugin rejected the command unsigned (§12.5 reason). */
  rejectedReason?: string;
}

export interface DispatchOptions {
  /** Additional legitimate WP-PK (§8 — a prepared-but-unconfirmed new key). */
  altWpPk?: string | null;
}

/**
 * A bound signed-command transport: method + params in, verified `CommandReply`
 * out. `iwsl-managed-ops` supplies one by binding a link record and a delivery
 * (exec or HTTPS) onto `dispatchSignedCommand`.
 */
export type RpcTransport = (
  method: RpcMethod,
  params: Record<string, unknown>,
  opts?: DispatchOptions,
) => Promise<CommandReply>;

/**
 * Typed funnel for the six signed commands. Confirms the method is registered —
 * the same allow-list the plugin enforces, a programming error otherwise — then
 * forwards it, unchanged, to the transport. No wire change versus a direct
 * `dispatchSignedCommand` call: identical method string, identical params object.
 */
export async function callRpc<M extends RpcMethod>(
  transport: RpcTransport,
  method: M,
  params: RpcParams[M],
  opts?: DispatchOptions,
): Promise<CommandReply> {
  if (!(method in RPC_REGISTRY)) {
    throw new Error(`callRpc: ${method} is not an allow-listed IWSL method`);
  }
  return transport(method, params as Record<string, unknown>, opts);
}
