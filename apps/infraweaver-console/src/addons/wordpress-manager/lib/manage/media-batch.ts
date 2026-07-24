/**
 * Media Explorer — the PURE, framework-free core the flagship bulk flows lean on:
 *
 *  - `chunkIds` / `planOptimizeBatches`: split a selection into bounded batches so
 *    "select all non-lossless → make lossless" feeds `media.optimize` in
 *    ≤ OPTIMIZE_BATCH-sized signed calls (the connector's `run()` batches the same
 *    size and reports `partial`; the console loops the chunks).
 *  - `collectMatchingIds`: the honest select-all-matching mechanism. `media.list`
 *    with `include_ids:true` returns the full matching id set in one call (capped
 *    at MATCH_IDS_MAX); when it caps, this LOOPS the filtered pages to gather the
 *    overflow. Injected fetchers keep it testable with no React/fetch.
 *  - `optimizationChip` / `offloadChip`: the row status → pill mapping the table
 *    renders (the "CDN" + "Lossless" columns).
 *
 * Everything here is pure and returns NEW arrays — no mutation, no side effects.
 */

import type { PillTone } from "../../components/demo/manage/kit/pill";
import { MATCH_IDS_MAX, OPTIMIZE_BATCH, type MediaOffload, type MediaOptimization } from "./media";

// ── batching ──────────────────────────────────────────────────────────────────

/** Split ids into consecutive batches of at most `size` (drops non-positive size). */
export function chunkIds(ids: readonly number[], size: number): number[][] {
  if (size < 1) return ids.length ? [[...ids]] : [];
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

/** The optimize plan: the selection chunked into OPTIMIZE_BATCH-sized signed calls. */
export function planOptimizeBatches(ids: readonly number[]): number[][] {
  return chunkIds(ids, OPTIMIZE_BATCH);
}

/** Merge id lists preserving first-seen order and dropping duplicates + non-positives. */
export function mergeIds(...lists: ReadonlyArray<readonly number[]>): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const id = Math.trunc(raw);
      if (id > 0 && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

// ── select-all-matching (the load-bearing "select the query, not the page") ────

export interface MatchIdsPage {
  /** The matching ids (≤ MATCH_IDS_MAX on the first call). */
  readonly ids: readonly number[];
  /** True when more matched than the single-call cap. */
  readonly capped: boolean;
  /** Total matching count — drives how many overflow pages to walk. */
  readonly total: number;
  /** The list page size, for computing the overflow page count. */
  readonly perPage: number;
}

export interface CollectMatchingDeps {
  /** `media.list` with `include_ids:true` — one call, up to MATCH_IDS_MAX ids. */
  readonly fetchMatchIds: () => Promise<MatchIdsPage>;
  /** The item ids of one filtered list page — used only to gather the capped overflow. */
  readonly fetchPageIds: (page: number) => Promise<readonly number[]>;
  /** Hard ceiling on ids collected in the capped path (safety bound). */
  readonly maxIds?: number;
}

export interface MatchingSelection {
  readonly ids: readonly number[];
  /** True when the true match set exceeds what we could safely gather. */
  readonly capped: boolean;
  readonly total: number;
}

/**
 * Resolve the full set of ids matching the active filter. The fast path is one
 * `include_ids` call; only when the server caps do we LOOP the filtered pages to
 * collect the overflow, bounded by `maxIds`. Pure w.r.t. the injected fetchers,
 * so the loop is unit-testable end to end.
 */
export async function collectMatchingIds(deps: CollectMatchingDeps): Promise<MatchingSelection> {
  const maxIds = deps.maxIds ?? Math.max(MATCH_IDS_MAX * 4, MATCH_IDS_MAX);
  const first = await deps.fetchMatchIds();
  if (!first.capped) {
    return { ids: mergeIds(first.ids), capped: false, total: first.total };
  }

  const perPage = Math.max(1, first.perPage);
  const pages = Math.ceil(first.total / perPage);
  let collected: number[] = mergeIds(first.ids);
  for (let page = 1; page <= pages; page += 1) {
    if (collected.length >= maxIds) break;
    const pageIds = await deps.fetchPageIds(page);
    collected = mergeIds(collected, pageIds);
  }
  const capped = collected.length < first.total;
  return { ids: collected.slice(0, maxIds), capped, total: first.total };
}

// ── row status → pill mapping (the "Lossless" + "CDN" columns) ─────────────────

export interface StatusChip {
  readonly label: string;
  readonly tone: PillTone;
  /** True when the feature is present/active for this row (drives the active tone). */
  readonly active: boolean;
}

/**
 * Optimization state → the "Lossless" pill. `null` = the optimizer feature is off
 * for this site (blank column, neutral). Optimized rows carry the saved percentage
 * when known; eligible-but-untouched rows read "Not lossless" (the bulk target).
 */
export function optimizationChip(opt: MediaOptimization | null): StatusChip {
  if (opt === null) return { label: "—", tone: "neutral", active: false };
  if (opt.status === "optimized") {
    const saved = typeof opt.saved_pct === "number" && opt.saved_pct > 0 ? ` · −${opt.saved_pct}%` : "";
    return { label: `Lossless${saved}`, tone: "good", active: true };
  }
  if (opt.status === "original") return { label: "Not lossless", tone: "warn", active: false };
  return { label: "Not eligible", tone: "neutral", active: false };
}

/**
 * Offload state → the "CDN" pill. `null` = the feature is off (blank, neutral).
 * "On CDN" means the asset is served from the bucket (offloaded); otherwise Local.
 */
export function offloadChip(off: MediaOffload | null): StatusChip {
  if (off === null) return { label: "—", tone: "neutral", active: false };
  if (off.status === "offloaded") return { label: "On CDN", tone: "good", active: true };
  return { label: "Local", tone: "neutral", active: false };
}

/** True when a row is eligible to be made lossless (the "Not lossless" bulk target). */
export function isOptimizable(opt: MediaOptimization | null): boolean {
  return opt !== null && opt.status === "original";
}

/** True when a row can be offloaded to the CDN bucket (currently local). */
export function isOffloadable(off: MediaOffload | null): boolean {
  return off !== null && off.status === "local";
}
