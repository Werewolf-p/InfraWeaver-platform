/**
 * Insights (analytics) — the console-side TYPES + zod request validators for the
 * three READ-ONLY signed `stats.*` / `activity.log` commands behind the Insights
 * surface. Isomorphic (no `server-only`): the API route parses requests through
 * these schemas, and the client narrows responses against these types. Every
 * bound + range vocabulary MIRRORS the connector's `IWSL_Statistics` /
 * `IWSL_Activity_Log` validators so the two sides can never drift — a request
 * this module accepts is one the plugin's validator also accepts.
 *
 * Only bounded AGGREGATES cross the wire (the drill island, heatmap and raw hit
 * rows stay WP-side); the shapes here mirror the connector's compact
 * `summary_payload()` / `timeseries_payload()` / `wire_log()` projections exactly.
 */

import { z } from "zod";

// ── bounds (mirror IWSL_Statistics / IWSL_Activity_Log constants; keep lockstep) ─
/** Allowed `stats.summary` ranges (IWSL_Statistics::ALLOWED_RANGES). */
export const STATS_RANGES = [1, 7, 30] as const;
export type StatsRange = (typeof STATS_RANGES)[number];
/** Default range when none is requested (IWSL_Statistics::DEFAULT_RANGE). */
export const DEFAULT_STATS_RANGE: StatsRange = 7;
/** Max days for `stats.timeseries` (IWSL_Stats_Classifier::SERIES_DAYS). */
export const SERIES_DAYS_MAX = 30;
/** Default `stats.timeseries` day count (the full window). */
export const DEFAULT_SERIES_DAYS = 30;
/** Max entries for `activity.log` (IWSL_Activity_Log::WIRE_MAX_ENTRIES). */
export const ACTIVITY_LIMIT_MAX = 100;
/** Default `activity.log` limit (IWSL_Activity_Log::WIRE_DEFAULT_LIMIT). */
export const ACTIVITY_DEFAULT_LIMIT = 50;

// ── gate descriptor (mirrors IWSL_Entitlements::evaluate() — the honest reasons) ─
/**
 * The gate the connector returns for a LOCKED feature, straight off
 * `IWSL_Entitlements::evaluate()`. `reasons` carries the machine codes we
 * translate to plain language (`not-linked` / `heartbeat-stale` / `requires-plus`);
 * `plus` is whether the paid entitlement is granted in the site's tier.
 */
export interface InsightsGate {
  readonly feature?: string;
  readonly unlocked?: boolean;
  readonly linked?: boolean;
  readonly plus?: boolean;
  readonly heartbeat_fresh?: boolean;
  readonly state?: string;
  readonly reasons?: readonly string[];
}

/** A compact `[label, count]` aggregate pair (mirrors the connector's flattened pairs). */
export type StatPair = readonly [string, number];

// ── stats.summary response (mirrors IWSL_Stats_Classifier::summary_payload) ─────
export interface StatsKpi {
  readonly views: number;
  readonly visits: number;
  readonly events: number;
  readonly views_today: number;
  readonly online_now: number;
  readonly prev_views: number;
  readonly prev_visits: number;
  /** % delta vs the previous window, or null when there is no prior baseline. */
  readonly views_delta_pct: number | null;
  readonly visits_delta_pct: number | null;
}

export interface StatsQuality {
  readonly bounce_pct: number;
  readonly pages_per_visit: number;
}

/** Privacy posture — DNT + GPC always honored; `consent_gated` reflects the live banner. */
export interface StatsPrivacy {
  readonly dnt: number;
  readonly gpc: number;
  readonly consent_gated: number;
}

export interface StatsSummaryResponse {
  readonly locked: boolean;
  readonly range_days?: number;
  readonly generated?: number;
  readonly kpi?: StatsKpi;
  readonly quality?: StatsQuality;
  readonly top_pages?: readonly StatPair[];
  readonly top_referrers?: readonly StatPair[];
  readonly channels?: readonly StatPair[];
  readonly devices?: readonly StatPair[];
  readonly countries?: readonly StatPair[];
  readonly searches?: readonly StatPair[];
  readonly privacy?: StatsPrivacy;
  readonly gate?: InsightsGate;
}

// ── stats.timeseries response (mirrors IWSL_Stats_Classifier::timeseries_payload) ─
export interface SeriesPoint {
  /** `Y-m-d`, site-local. */
  readonly day: string;
  readonly views: number;
  readonly visits: number;
}

export interface HourPoint {
  readonly hour: number;
  readonly views: number;
  readonly visits: number;
}

export interface StatsTimeseriesResponse {
  readonly locked: boolean;
  readonly days?: number;
  readonly series?: readonly SeriesPoint[];
  /** Present only when `days === 1` (today's hourly + previous day). */
  readonly hourly?: readonly HourPoint[];
  readonly hourly_prev?: readonly HourPoint[];
  readonly gate?: InsightsGate;
}

// ── activity.log response (mirrors IWSL_Activity_Log::wire_log) ─────────────────
export interface ActivityEntry {
  /** Unix seconds. */
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly object: string;
  readonly summary: string;
}

export interface ActivityLogResponse {
  readonly locked: boolean;
  /** Newest-first, byte-bounded by the connector. */
  readonly entries?: readonly ActivityEntry[];
  readonly gate?: InsightsGate;
}

// ── request validators (parity with the connector's validate_* methods) ─────────

/** `stats.summary` params — empty, or `{ range_days: 1|7|30 }` (validate_summary_params). */
export const statsSummaryParamsSchema = z
  .object({
    range_days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(),
  })
  .strict();
export type StatsSummaryParams = z.infer<typeof statsSummaryParamsSchema>;

/** `stats.timeseries` params — empty, or `{ days: 1..30 }` (validate_timeseries_params). */
export const statsTimeseriesParamsSchema = z
  .object({
    days: z.number().int().min(1).max(SERIES_DAYS_MAX).optional(),
  })
  .strict();
export type StatsTimeseriesParams = z.infer<typeof statsTimeseriesParamsSchema>;

/** `activity.log` params — empty, or `{ limit: 1..100 }` (validate_log_params). */
export const activityLogParamsSchema = z
  .object({
    limit: z.number().int().min(1).max(ACTIVITY_LIMIT_MAX).optional(),
  })
  .strict();
export type ActivityLogParams = z.infer<typeof activityLogParamsSchema>;

/** The read verbs (GET) the insights route serves — one signed method each. */
export const INSIGHTS_READ_VERBS = ["summary", "timeseries", "activity"] as const;
export type InsightsReadVerb = (typeof INSIGHTS_READ_VERBS)[number];

export function isInsightsReadVerb(v: string): v is InsightsReadVerb {
  return (INSIGHTS_READ_VERBS as readonly string[]).includes(v);
}
