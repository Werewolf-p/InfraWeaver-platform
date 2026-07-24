/**
 * Bulk-run LEDGER — the pure, framework-free core behind `BulkActionBar`'s
 * per-item progress. Generalized from `fleet-bulk-toolbar.tsx`, which tracked a
 * per-SITE run; here the unit is any string id, so media conversions, redirect
 * edits and plugin updates all share one tested engine. No React, no fetch — the
 * view layer (`run-ledger.tsx`) renders whatever this produces.
 */

export type RunStatus = "pending" | "running" | "ok" | "error";

/** One tracked item and its current run state. */
export interface ItemRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly message?: string;
}

/** The outcome a worker reports for a single item. */
export interface ItemOutcome {
  readonly ok: boolean;
  readonly message?: string;
}

/** A roll-up of a ledger — drives the summary line + completion toast. */
export interface RunSummary {
  readonly total: number;
  readonly ok: number;
  readonly failed: number;
  readonly done: boolean;
}

/** A fresh ledger: every id pending, order preserved. */
export function initLedger(ids: readonly string[]): ItemRun[] {
  return ids.map((id) => ({ id, status: "pending" as const }));
}

function setStatus(ledger: readonly ItemRun[], id: string, status: RunStatus, message?: string): ItemRun[] {
  return ledger.map((run) => (run.id === id ? { id, status, message } : run));
}

/** Mark an item as in-flight. Returns a new ledger. */
export function markRunning(ledger: readonly ItemRun[], id: string): ItemRun[] {
  return setStatus(ledger, id, "running");
}

/** Record an item's terminal outcome. Returns a new ledger. */
export function markDone(ledger: readonly ItemRun[], id: string, outcome: ItemOutcome): ItemRun[] {
  return setStatus(ledger, id, outcome.ok ? "ok" : "error", outcome.message);
}

/** How many items have reached a terminal state (ok or error). */
export function completedCount(ledger: readonly ItemRun[]): number {
  return ledger.reduce((n, run) => n + (run.status === "ok" || run.status === "error" ? 1 : 0), 0);
}

/** Roll a ledger up into a summary. */
export function summarize(ledger: readonly ItemRun[]): RunSummary {
  let ok = 0;
  let failed = 0;
  for (const run of ledger) {
    if (run.status === "ok") ok += 1;
    else if (run.status === "error") failed += 1;
  }
  return { total: ledger.length, ok, failed, done: ok + failed === ledger.length };
}

/**
 * Bounded-concurrency fan-out that drives a ledger. `worker` runs each id (a
 * thrown error is caught and recorded as a failure); `onUpdate` receives the new
 * ledger after every transition (running → ok/error) so a UI re-renders live.
 * Resolves with the FINAL ledger. Mirrors the fleet toolbar's `runWithConcurrency`,
 * generalized to arbitrary ids plus a ledger.
 */
export async function runItems(
  ids: readonly string[],
  worker: (id: string) => Promise<ItemOutcome>,
  onUpdate: (ledger: readonly ItemRun[]) => void,
  concurrency = 3,
): Promise<ItemRun[]> {
  let ledger: ItemRun[] = initLedger(ids);
  onUpdate(ledger);
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, ids.length || 1));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= ids.length) return;
        const id = ids[index];
        ledger = markRunning(ledger, id);
        onUpdate(ledger);
        let outcome: ItemOutcome;
        try {
          outcome = await worker(id);
        } catch (error) {
          outcome = { ok: false, message: error instanceof Error ? error.message : "Failed" };
        }
        ledger = markDone(ledger, id, outcome);
        onUpdate(ledger);
      }
    }),
  );
  return ledger;
}
