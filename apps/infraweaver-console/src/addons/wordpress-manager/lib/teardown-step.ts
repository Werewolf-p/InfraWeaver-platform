/**
 * Shared result model for site teardown (delete). Pure (no server deps) so both
 * the resource-level teardown in `provision.deleteSite` and the top-level
 * orchestrator in `site-teardown.teardownSite` speak the same shape and can be
 * unit-tested without a cluster. Kept in its own module to avoid an import cycle
 * (provision ⇄ site-teardown would otherwise close a loop through this type).
 */

/**
 * The outcome of one teardown step:
 *  - `removed`  — the resource existed and was deleted.
 *  - `skipped`  — the resource was already absent / not applicable (idempotent
 *                 no-op; a retry sees the same clean state).
 *  - `failed`   — the delete threw and the resource may still exist; the overall
 *                 teardown continues so one failure never strands the rest, and
 *                 the whole flow stays safe to re-run to completion.
 */
export type TeardownStatus = "removed" | "skipped" | "failed";

export interface TeardownStep {
  /** Stable identifier for the resource acted on, e.g. `pvc/<site>-wp-data`. */
  step: string;
  status: TeardownStatus;
  /** Human-readable note (why skipped, or the failure message). */
  detail?: string;
}

/** What a step body may return to override the default `removed` outcome. */
export type StepOutcome = { status: TeardownStatus; detail?: string } | void;

/**
 * Run one teardown step, never throwing: a thrown error becomes a `failed` step
 * so the caller can keep tearing the rest of the site down and report the
 * failure. A void/absent return means the delete succeeded (`removed`).
 */
export async function runStep(step: string, body: () => Promise<StepOutcome>): Promise<TeardownStep> {
  try {
    const outcome = await body();
    if (outcome && outcome.status) return { step, status: outcome.status, detail: outcome.detail };
    return { step, status: "removed" };
  } catch (err) {
    return { step, status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** True when no step failed — the site is fully torn down. */
export function teardownOk(steps: readonly TeardownStep[]): boolean {
  return steps.every((s) => s.status !== "failed");
}

/** Compact `removed=… skipped=… failed=…` tally for audit-log detail lines. */
export function summarizeTeardown(steps: readonly TeardownStep[]): string {
  const tally = { removed: 0, skipped: 0, failed: 0 } as Record<TeardownStatus, number>;
  for (const s of steps) tally[s.status] += 1;
  const failed = steps.filter((s) => s.status === "failed").map((s) => s.step);
  const base = `removed=${tally.removed} skipped=${tally.skipped} failed=${tally.failed}`;
  return failed.length > 0 ? `${base} (failed: ${failed.join(", ")})` : base;
}
