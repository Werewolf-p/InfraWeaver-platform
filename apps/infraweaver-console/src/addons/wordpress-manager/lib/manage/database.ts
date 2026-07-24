/**
 * Database fusion — the console-side TYPES + zod request validators for the three
 * signed `db.*` commands (`db.analyze`, `db.cleanup`, `db.schedule`). Isomorphic
 * (no `server-only`): the dedicated API route parses requests through these
 * schemas and the client narrows responses against these types. Every bound and
 * enum vocabulary MIRRORS the connector's validators in
 * `IWSL_Plugin::command_handlers()` (the `db.*` block) + `IWSL_DB_Optimizer` /
 * `IWSL_DB_Analyzer` / `IWSL_Scheduled_DB_Cleanup`, so the two sides can never
 * drift — a request this module accepts is one the plugin's validator also
 * accepts.
 *
 * PREVIEW-BY-DEFAULT is the load-bearing invariant: `dry_run` is a REQUIRED real
 * boolean, and the connector deletes only on a literal `false`. The console never
 * ships a raw `wp db optimize` / purge-all-transients path — every mutation is one
 * of these bounded, gated signed commands.
 */

import { z } from "zod";

// ── bounds (mirror IWSL_DB_Optimizer constants; keep in lockstep) ─────────────
/** Per-DELETE / per-OPTIMIZE row cap the engine clamps DOWN to (never up). */
export const MAX_ROWS = 1000;
/** Ceiling on categories selected per `db.cleanup` / `db.schedule` call. */
export const MAX_CLEANERS_PER_RUN = 32;
/** Autoload weight over this many KB drags every page load (reuses the panel constant). */
export const AUTOLOAD_WARN_KB = 800;
/** Cleaner-id shape — the ONLY thing an id may ever be (never a table name). */
export const CATEGORY_ID_RE = /^[a-z0-9_]{1,32}$/;

// ── cadence vocabulary (first entry = safe default) ───────────────────────────
export const SCHEDULE_FREQUENCIES = ["daily", "weekly"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

/** The gate descriptor the connector returns (evaluate() + local switch state). */
export interface DbGate {
  readonly feature?: string;
  readonly unlocked?: boolean;
  readonly linked?: boolean;
  readonly heartbeat_fresh?: boolean;
  readonly plus?: boolean;
  readonly state?: string;
  readonly reasons?: readonly string[];
  /** True when the tier grants it but the site's kill switch is off. */
  readonly switched_off?: boolean;
  readonly tier?: string;
}

/** The engine caps, surfaced in the UI copy (rows-per-category + registry ids). */
export interface DbCaps {
  readonly max_rows: number;
  readonly categories: readonly string[];
}

/** Whole-DB totals; `null` means "unknown" (restricted information_schema), never zero. */
export interface DbTotals {
  readonly db_mb: number | null;
  readonly overhead_mb: number | null;
}

/** One table's size + reclaimable overhead (DATA_FREE), largest first. */
export interface DbTableRow {
  readonly name: string;
  readonly size_mb: number;
  readonly overhead_mb: number;
}

/** One heavy autoloaded option — NAME + BYTE SIZE only, never the value. */
export interface DbAutoloadTop {
  readonly name: string;
  readonly kb: number;
}

export interface DbAutoload {
  readonly count: number;
  readonly kb: number | null;
  readonly top: readonly DbAutoloadTop[];
}

/** A cleanup category with its live preview row count. */
export interface DbCategoryCount {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/** The scheduler's stored last run (or null before the first run). */
export interface DbLastRun {
  readonly at: number;
  readonly ok: boolean;
  readonly mode: string;
  readonly total: number;
  readonly reason: string;
}

/** The automation card's read-model. */
export interface DbSchedule {
  readonly unlocked: boolean;
  readonly enabled: boolean;
  readonly frequency: string;
  readonly categories: readonly string[];
  readonly next_run: number | null;
  readonly last_run: DbLastRun | null;
}

/** One cleaner entry inside a history record (id + rows removed). */
export interface DbHistoryCleaner {
  readonly id: string;
  readonly deleted: number;
}

/** One capped, non-dry run in the bounded history ring. */
export interface DbHistoryEntry {
  readonly at: number;
  readonly source: string;
  readonly total: number;
  readonly cleaners: readonly DbHistoryCleaner[];
}

/**
 * `db.analyze` verified response. A locked/switched-off site returns
 * `{ locked: true, gate, caps }` only — every sizing field is absent (the engine
 * performs ZERO queries), so the console renders the base wp-cli probe plus the
 * locked/upsell state and never fabricates zeros.
 */
export interface DbAnalyzeResponse {
  readonly locked: boolean;
  readonly gate: DbGate;
  readonly caps: DbCaps;
  readonly totals?: DbTotals;
  readonly tables?: readonly DbTableRow[];
  readonly autoload?: DbAutoload;
  readonly schema_available?: boolean;
  readonly categories?: readonly DbCategoryCount[];
  readonly schedule?: DbSchedule;
  readonly history?: readonly DbHistoryEntry[];
}

/** A preview cleaner row (`db.cleanup` dry_run: true). */
export interface DbCleanupPreviewRow {
  readonly id: string;
  readonly label: string;
  readonly count: number;
}

/** A real-run cleaner row (`db.cleanup` dry_run: false). */
export interface DbCleanupRunRow {
  readonly id: string;
  readonly label: string;
  readonly deleted: number;
}

/**
 * `db.cleanup` verified response — the bounded optimizer summary plus the
 * effective per-category cap. `mode` is the engine's own verdict of what it did
 * (`preview` unless it received a literal `dry_run: false`).
 */
export interface DbCleanupResponse {
  readonly ok: boolean;
  readonly mode: "preview" | "run";
  readonly cleaners: readonly (DbCleanupPreviewRow | DbCleanupRunRow)[];
  readonly total: number;
  readonly elapsed_ms?: number;
  /** The cap the engine actually applied (max_rows clamped to [1, MAX_ROWS]). */
  readonly cap: number;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly gate?: DbGate;
}

export interface DbScheduleSettings {
  readonly enabled: boolean;
  readonly frequency: string;
  readonly categories: readonly string[];
  readonly saved_at?: number;
}

/** `db.schedule` verified response — the stored settings echo + the next run. */
export interface DbScheduleResponse {
  readonly ok: boolean;
  readonly settings?: DbScheduleSettings;
  readonly next_run?: number | null;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly gate?: DbGate;
}

// ── request validators (parity with the plugin's db.* validators) ─────────────

const categoryList = z
  .array(z.string().regex(CATEGORY_ID_RE))
  .max(MAX_CLEANERS_PER_RUN);

/**
 * `db.cleanup` params — mirrors the plugin validator exactly: `categories` an
 * array of registry-shaped ids (≤ MAX_CLEANERS_PER_RUN), `dry_run` a REQUIRED
 * real boolean (preview-by-default depends on deletion firing only on literal
 * `false`), optional integer `max_rows`. Strays refused.
 */
export const dbCleanupParamsSchema = z
  .object({
    categories: categoryList,
    dry_run: z.boolean(),
    max_rows: z.number().int().positive().optional(),
  })
  .strict();

export type DbCleanupParams = z.infer<typeof dbCleanupParamsSchema>;

/**
 * `db.schedule` params — `enabled` a real boolean, `frequency` clamped to the
 * allow-list, optional `categories` subset (empty ⇒ all, sanitized server-side).
 */
export const dbScheduleParamsSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    categories: categoryList.optional(),
  })
  .strict();

export type DbScheduleParams = z.infer<typeof dbScheduleParamsSchema>;

/** The write verbs the dedicated database route dispatches (signed method per verb). */
export const DB_WRITE_VERBS = ["cleanup", "schedule"] as const;
export type DbWriteVerb = (typeof DB_WRITE_VERBS)[number];

/** The read verbs (GET) the database route serves. */
export const DB_READ_VERBS = ["analyze"] as const;
export type DbReadVerb = (typeof DB_READ_VERBS)[number];
