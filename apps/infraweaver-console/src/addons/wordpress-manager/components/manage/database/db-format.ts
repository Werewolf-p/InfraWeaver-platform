/**
 * Small pure formatters shared by the Database cockpit zones. No React, no I/O —
 * kept isolated so they are trivially unit-testable and reused across the health
 * strip, cleanup grid, automation card, and bloat drill-down.
 */

/** Thousands-separated integer/float. */
export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** A unix-seconds timestamp as a short local date-time, or an em dash when absent. */
export function fmtTs(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  return new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Coarse relative time from now for a unix-seconds timestamp ("in 3h", "2d ago").
 * Future timestamps read "in …"; past ones "… ago"; absent → em dash.
 */
export function fmtRelative(seconds: number | null | undefined, nowMs: number = Date.now()): string {
  if (!seconds || seconds <= 0) return "—";
  const deltaSec = seconds - Math.floor(nowMs / 1000);
  const future = deltaSec >= 0;
  const abs = Math.abs(deltaSec);
  const unit =
    abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

/** The one non-row-deleting cleaner — surfaced as the dedicated "Safe optimize" action. */
export const OPTIMIZE_CATEGORY_ID = "optimize_tables";

/**
 * Whether a preview total exceeded the per-category cap on any selected category,
 * i.e. the run will need to be repeated to continue. `rows` are the previewed
 * per-category counts; `cap` is the effective clamp.
 */
export function previewExceedsCap(rows: readonly { count: number }[], cap: number): boolean {
  return rows.some((r) => r.count > cap);
}
