import "server-only";
import type { FeedbackEntry } from "@/lib/feedback-store";
import {
  DISPATCH_LONG_TIMEOUT_MS,
  DISPATCH_QUICK_TIMEOUT_MS,
  dispatchGet,
  dispatchMutate,
  type DispatchMutationResult,
} from "@/lib/dispatch-client";

/**
 * Direct client for the InfraWeaver dispatch service (no n8n).
 *
 * The dispatch service (`infraweaver-dispatch`, runs on the runner, reachable
 * in-cluster) drives the single-branch feedback pipeline: on /approve it runs
 * Claude (plan → validate → implement) on `feedback/staging`, builds the console
 * image in-cluster (BuildKit → Zot), and deploys an ephemeral preview. /validate
 * records the reviewer verdict; /publish merges staging → main and releases.
 *
 * Transport, fail-safe (missing DISPATCH_URL → `skipped`), fail-closed
 * (missing DISPATCH_SECRET → mutations refused) and HMAC signing all live in
 * `@/lib/dispatch-client`; triage is never blocked by integration wiring.
 *
 *   DISPATCH_URL  e.g. http://10.10.0.92:9876  (cluster/runner-internal only)
 *
 * /approve, /validate(not_fixed) and /publish are LONG (~15-20 min: agent run +
 * in-cluster build). They are fired in the background by the API routes; the
 * dispatch service creates a run record immediately and the dashboard streams
 * its live log + phases. These helpers therefore use a generous timeout and the
 * callers do not block the HTTP response on them.
 */
const DISPATCH_URL = process.env.DISPATCH_URL;

export interface DispatchResult {
  ok: boolean;
  /** True when DISPATCH_URL is unset — the status change succeeded, the call was skipped. */
  skipped?: boolean;
  error?: string;
  /** Dispatch run id for the live console / audit history (when the call started a run). */
  runId?: string;
  previewUrl?: string;
  testPath?: string;
  tag?: string;
  releaseTag?: string;
  prodImage?: string;
}

/** Outcome the reviewer picks after testing the preview on the cluster. */
export type ValidationAction = "validated" | "not_fixed";

/** A dispatch run record (audit history entry). Mirrors server.js `newRun`. */
export interface DispatchRun {
  runId: string;
  feedbackId: string;
  kind: string;
  phase: string;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  previewUrl: string | null;
  tag: string | null;
  commit: string | null;
  changeClass?: string;
  error?: string;
}

/** Flatten a dispatch-client mutation result back into the flat DispatchResult shape. */
function toDispatchResult(result: DispatchMutationResult<Partial<DispatchResult>>): DispatchResult {
  const { data, ...rest } = result;
  return { ...rest, ...data };
}

/**
 * Approve → dispatch /approve (plan → validate → implement → build → preview).
 * LONG-running: callers fire this in the background and stream progress.
 */
export async function dispatchApprovedFeedback(entry: FeedbackEntry, note?: string): Promise<DispatchResult> {
  return toDispatchResult(
    await dispatchMutate<Partial<DispatchResult>>(
      "/approve",
      {
        feedbackId: entry.id,
        description: entry.description,
        pagePath: entry.pagePath,
        type: entry.type,
        ...(note ? { note } : {}),
      },
      { timeoutMs: DISPATCH_LONG_TIMEOUT_MS },
    ),
  );
}

/**
 * Reviewer verdict → dispatch /validate. `validated` is quick (keeps the commit
 * on staging). `not_fixed` is LONG (revert + re-run the cycle with the note) so
 * it carries the full context the redo needs.
 */
export async function validateFeedback(
  entry: FeedbackEntry,
  action: ValidationAction,
  note?: string,
): Promise<DispatchResult> {
  return toDispatchResult(
    await dispatchMutate<Partial<DispatchResult>>(
      "/validate",
      {
        feedbackId: entry.id,
        action,
        note: note ?? "",
        description: entry.description,
        pagePath: entry.pagePath,
        type: entry.type,
      },
      { timeoutMs: action === "not_fixed" ? DISPATCH_LONG_TIMEOUT_MS : DISPATCH_QUICK_TIMEOUT_MS },
    ),
  );
}

/**
 * Publish all accepted changes → dispatch /publish (merge staging → main, build
 * + release image, bump prod image pin). LONG-running.
 */
export async function publishAllFeedback(): Promise<DispatchResult> {
  return toDispatchResult(
    await dispatchMutate<Partial<DispatchResult>>("/publish", {}, { timeoutMs: DISPATCH_LONG_TIMEOUT_MS }),
  );
}

/** List dispatch run records for an entry (newest first). Read-only / quick. */
export async function listFeedbackRuns(feedbackId: string): Promise<DispatchRun[]> {
  const payload = await dispatchGet<{ runs?: DispatchRun[] }>(`/runs?feedbackId=${encodeURIComponent(feedbackId)}`);
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

/** Fetch one run's full transcript. Read-only / quick. */
export async function getFeedbackRunLog(runId: string): Promise<{ run: DispatchRun; log: string } | null> {
  return dispatchGet<{ run: DispatchRun; log: string }>(`/runs/${encodeURIComponent(runId)}/log`);
}

/**
 * Open the dispatch SSE stream for a run (live log + phases). Returns the raw
 * upstream Response so a console proxy route can pipe its body to the browser.
 * No timeout — the stream stays open for the life of the run.
 */
export async function openFeedbackRunStream(runId: string): Promise<Response | null> {
  if (!DISPATCH_URL) return null;
  try {
    const res = await fetch(new URL(`/runs/${encodeURIComponent(runId)}/stream`, DISPATCH_URL), {
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) return null;
    return res;
  } catch {
    return null;
  }
}

export { isDispatchConfigured } from "@/lib/dispatch-client";
