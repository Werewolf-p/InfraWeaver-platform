/**
 * §8 per-site auto-rotation policy bounds. Pure (no server deps) so the clamp
 * is unit-testable and importable from both the sweep (read path) and the
 * managed-ops mutator (write path) without an import cycle.
 *
 * SECURITY: these bounds are the guardrail on operator-tunable key-rotation
 * cadence. The floor stops `intervalMs` = 0/tiny from turning the scheduled
 * sweep into "reroll every run" (which would hammer the PQ signing path and
 * churn live keys); the ceiling stops a fat-fingered huge number from silently
 * meaning "never rotate" — disabling rotation is an explicit `autoRotate:false`,
 * not an accident. The per-run blast-radius cap (`HARD_MAX_PER_RUN`) is enforced
 * separately in the sweep and is NOT weakened by any per-site interval.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Lowest a single link may set its rotation age gate: 1 hour. */
export const MIN_SITE_INTERVAL_MS = MS_PER_HOUR;
/** Highest a single link may set its rotation age gate: 1 year. */
export const MAX_SITE_INTERVAL_MS = 365 * MS_PER_DAY;

/**
 * Clamp a requested per-site rotation interval to the safe range. Non-finite
 * input collapses to the floor (fail-safe: a garbage value rotates sooner, it
 * never disables rotation). Fractional ms are floored.
 */
export function clampRotationIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_SITE_INTERVAL_MS;
  return Math.min(MAX_SITE_INTERVAL_MS, Math.max(MIN_SITE_INTERVAL_MS, Math.floor(ms)));
}
