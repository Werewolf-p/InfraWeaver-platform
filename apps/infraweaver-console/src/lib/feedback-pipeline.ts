import "server-only";
import type { FeedbackEntry } from "@/lib/feedback-store";
import { patchFeedbackEntry, markAllAcceptedDone, updateFeedbackStatus } from "@/lib/feedback-store";
import {
  dispatchApprovedFeedback,
  validateFeedback,
  publishAllFeedback,
  listFeedbackRuns,
} from "@/lib/feedback-dispatch";

/**
 * Background orchestration for the LONG dispatch operations (approve / redo /
 * publish, each ~15-20 min: agent run + in-cluster build).
 *
 * The console runs as a long-lived standalone Node server (`output: 'standalone'`,
 * single replica), so we fire these as detached promises: the API route returns
 * immediately, the dispatch service creates a run record at once (which the
 * dashboard streams live), and when the long call settles we reconcile the
 * entry's preview URL / run id / status from the dispatch run history — the
 * authoritative source that survives even a console restart.
 *
 * If the console pod restarts mid-run the dispatch run still completes and is
 * persisted on the runner; only the convenience write-back is lost, and the UI
 * still reads the result from the (proxied) run records.
 */

function logError(context: string, error: unknown): void {
  // Server-side diagnostic; console pod stdout is the operator's log here.
  console.error(`[feedback-pipeline] ${context}:`, error instanceof Error ? error.message : error);
}

/**
 * After a long approve/redo dispatch settles, pull the newest successful run for
 * this entry and write its preview URL + run id back, advancing the entry to
 * `dispatched` (awaiting reviewer verdict). Reviewer identity is preserved. If no
 * successful run produced a preview, the entry stays in `approved` so it never
 * gets stranded on the "Building on staging…" pill with no build to test.
 */
async function reconcileFromRuns(entry: FeedbackEntry): Promise<void> {
  const runs = await listFeedbackRuns(entry.id);
  const newestSuccess = runs.find((r) => r.status === "success" && r.previewUrl);
  if (newestSuccess?.previewUrl) {
    await patchFeedbackEntry(entry.id, {
      status: "dispatched",
      previewUrl: newestSuccess.previewUrl,
      testPath: entry.pagePath || "/",
      dispatchRunId: newestSuccess.runId,
    });
    return;
  }
  // No successful run with a preview — the build failed or produced no preview,
  // so there is nothing to test on staging. Revert to `approved` ("Claude is
  // fixing this…") rather than advancing to `dispatched`, which would strand the
  // entry on the misleading "Building on staging…" pill forever. Surface the
  // latest run id so the reviewer can open its log and see what failed.
  const newest = runs[0];
  await patchFeedbackEntry(entry.id, {
    status: "approved",
    ...(newest ? { dispatchRunId: newest.runId } : {}),
  });
}

/** Fire-and-forget detached promise on the long-lived server. */
function detach(work: () => Promise<void>, context: string): void {
  void work().catch((error) => logError(context, error));
}

/** Kick off an approve run in the background; resolves immediately. */
export function startApprove(entry: FeedbackEntry): void {
  detach(async () => {
    const result = await dispatchApprovedFeedback(entry);
    if (!result.ok) {
      logError(`approve ${entry.id} dispatch failed`, result.error);
    }
    await reconcileFromRuns(entry);
  }, `approve ${entry.id}`);
}

/** Kick off a not_fixed redo run in the background; resolves immediately. */
export function startRedo(entry: FeedbackEntry, note: string): void {
  detach(async () => {
    const result = await validateFeedback(entry, "not_fixed", note);
    if (!result.ok) {
      logError(`redo ${entry.id} dispatch failed`, result.error);
    }
    await reconcileFromRuns(entry);
  }, `redo ${entry.id}`);
}

/**
 * Kick off a publish run in the background; resolves immediately. On success,
 * drain every accepted entry to `done`/released.
 */
export function startPublish(actor: string): void {
  detach(async () => {
    const result = await publishAllFeedback();
    if (result.ok) {
      const ids = await markAllAcceptedDone(actor);
      logError(`publish released ${ids.length} entr${ids.length === 1 ? "y" : "ies"}`, result.releaseTag ?? "");
    } else {
      logError("publish dispatch failed", result.error);
    }
  }, "publish");
}

/**
 * An entry is stranded mid-pipeline — needing a reconcile-on-read — when it is
 * still `approved` (write-back never ran) OR it was advanced to `dispatched` but
 * carries no `previewUrl`. The latter happens when the console process is
 * restarted or crashes (the exit-139 bursts) after `reconcileFromRuns` flipped
 * the status to `dispatched` but before/while the preview URL was persisted,
 * leaving the entry stuck on the "Building on staging…" pill with nothing to
 * test. Both cases are healed from the authoritative dispatch run history.
 */
export function needsReconcile(entry: FeedbackEntry): boolean {
  return entry.status === "approved" || (entry.status === "dispatched" && !entry.previewUrl);
}

/**
 * Self-heal entries stranded mid-pipeline. The approve/redo write-back runs as a
 * detached promise inside the (single-replica) console process; if that process
 * is restarted or crashes (the exit-139 bursts) mid-run, an entry can stay stuck
 * — either in `approved` forever, or in `dispatched` with no preview URL — even
 * though the dispatch run finished on the runner. The dispatch run history is the
 * authoritative source that survives restarts, so on every list read we reconcile
 * any such entry whose run has since settled, backfilling its preview URL / test
 * path / run id. Best-effort and fail-safe: never throws, never blocks the list
 * response.
 */
export async function reconcileStaleEntries(entries: FeedbackEntry[]): Promise<void> {
  const stuck = entries.filter(needsReconcile);
  if (stuck.length === 0) return;
  await Promise.all(
    stuck.map(async (entry) => {
      try {
        const runs = await listFeedbackRuns(entry.id);
        if (runs.length === 0) return; // never dispatched / dispatch unreachable
        // Only advance once the latest run for this entry has actually settled —
        // a still-running approve must stay `approved`.
        if (runs.some((r) => r.status === "running")) return;
        await reconcileFromRuns(entry);
      } catch (error) {
        logError(`reconcile ${entry.id}`, error);
      }
    }),
  );
}

/** Quick accepted-verdict path: mark accepted + tell dispatch to keep the commit. */
export async function acceptVerdict(entry: FeedbackEntry, actor: string, note?: string): Promise<void> {
  await updateFeedbackStatus(entry.id, "accepted", actor, note);
  const result = await validateFeedback(entry, "validated", note);
  if (!result.ok && !result.skipped) {
    logError(`accept ${entry.id} validate failed`, result.error);
  }
}
