"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, ExternalLink, Loader2, MessageSquarePlus, Rocket, ThumbsDown, XCircle } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { ConfirmDialog } from "@/components/ui";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { useRBAC } from "@/hooks/use-rbac";
import { RunConsole } from "@/components/feedback/run-console";
import { PublishButton } from "@/components/feedback/publish-button";
import { StagingBanner } from "@/components/feedback/staging-banner";
import { StatusLegend } from "@/components/feedback/status-legend";
import { StatusPill } from "@/components/feedback/status-pill";
import {
  STAGING_ENV_URL,
  STATUS_COPY,
  TYPE_ICON,
  type FeedbackStatus,
  type FeedbackType,
} from "@/components/feedback/feedback-status";

interface FeedbackEntry {
  id: string;
  description: string;
  type: FeedbackType;
  pagePath: string;
  severity?: "low" | "medium" | "high" | "critical";
  status: FeedbackStatus;
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  previewUrl?: string;
  testPath?: string;
  released?: boolean;
  publishedAt?: string;
}

/** A pending confirmation for one of the destructive/heavy actions. */
type ConfirmState =
  | { kind: "deny"; entry: FeedbackEntry }
  | { kind: "retry"; entry: FeedbackEntry }
  | null;

/** Deep-link into the preview at the reported page (previewUrl + testPath). */
function buildTestLink(entry: FeedbackEntry): string | null {
  if (!entry.previewUrl) return null;
  try {
    return new URL(entry.testPath || entry.pagePath || "/", entry.previewUrl).toString();
  } catch {
    return entry.previewUrl;
  }
}

/** First line of a description, trimmed for compact summaries. */
function summarize(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine || "(no description)";
}

/**
 * Feedback review dashboard (client). Rendered only on the canonical console
 * host — the server page gates the host before mounting this. Approving hands
 * the entry to the dispatch service (plan → validate → implement → build →
 * preview); the reviewer then Accepts (keep on staging) or Redoes (revert +
 * retry), and Publishes all accepted changes to main.
 */
export function FeedbackReview() {
  const queryClient = useQueryClient();
  const { can } = useRBAC();
  const canManage = can("cluster:admin") || can("rbac:admin");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  // Local optimistic latch for heavy pipeline ops (retry / publish) between the
  // click and the next refetch, complementing the server-derived "approved"
  // signal below. Together they serialize the pipeline in the UI.
  const [pipelinePending, setPipelinePending] = useState(false);
  // The id of an approve we just fired but whose `approved` state we haven't yet
  // observed in refetched data. WITHOUT this, the pipeline looks idle in the gap
  // between the (fast) approve call returning and the next 10s poll, so a second
  // approve would dispatch immediately instead of queuing — exactly the "queue
  // doesn't work / things still lock" report (8dc5d87f). Holding busy until the
  // run is confirmed running closes that gap.
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  // Ids the reviewer approved while a run was in flight. Rather than locking the
  // Approve button, we queue these and auto-dispatch one as soon as the pipeline
  // is free (the backend serializes runs; this just mirrors "start when possible").
  // Persisted to sessionStorage so a refresh/navigation does not silently drop a
  // queued approval.
  const QUEUE_STORAGE_KEY = "infraweaver:feedback-queue";
  const [queuedApprovals, setQueuedApprovals] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = sessionStorage.getItem(QUEUE_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queuedApprovals));
    } catch {
      /* sessionStorage unavailable — queue stays in-memory only */
    }
  }, [queuedApprovals]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["feedback", "list"],
    queryFn: () => apiClient.get<{ entries: FeedbackEntry[] }>("/api/feedback"),
    // Auto-refresh so status transitions (reconciled by the background dispatch
    // run) show without a manual reload.
    refetchInterval: 10_000,
  });

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const acceptedEntries = useMemo(() => entries.filter((e) => e.status === "accepted"), [entries]);
  const acceptedCount = acceptedEntries.length;
  const acceptedTitles = useMemo(() => acceptedEntries.map((e) => summarize(e.description)), [acceptedEntries]);

  // The single shared staging environment. Every accepted fix accumulates here;
  // prefer a preview URL written back by dispatch, else the known shared URL.
  const stagingUrl = useMemo(
    () => entries.find((e) => e.previewUrl)?.previewUrl ?? STAGING_ENV_URL,
    [entries],
  );

  // A pipeline op is in flight if we just started one (heavy retry/publish latch
  // OR an approve we fired but haven't yet seen go `approved`), or any entry is
  // mid-run ("approved" = Claude working). The backend serializes these, so we
  // mirror that here and queue any further approvals until it frees up.
  const pipelineBusy =
    pipelinePending || dispatchingId !== null || entries.some((e) => e.status === "approved");

  // Clear the approve latch once its run is observed in refetched data — either it
  // reached `approved` (now covered by the entries check) or already moved past it.
  // Prevents the latch from sticking forever if a poll is missed.
  useEffect(() => {
    if (!dispatchingId) return;
    const entry = entries.find((e) => e.id === dispatchingId);
    if (!entry || entry.status !== "new") setDispatchingId(null);
  }, [dispatchingId, entries]);

  const updateStatus = useCallback(
    async (id: string, status: FeedbackStatus) => {
      const heavy = status === "approved";
      setBusyId(id);
      // For approve, latch on dispatchingId (held until the run is confirmed
      // running) rather than the transient pipelinePending, so the busy state
      // survives the gap until the next poll and the queue genuinely serializes.
      if (heavy) setDispatchingId(id);
      try {
        const result = await apiClient.patch<{
          entry: FeedbackEntry;
          dispatch?: { ok: boolean; skipped?: boolean; started?: boolean; error?: string };
        }>(`/api/feedback/${id}`, { json: { status } });
        if (status === "approved") {
          const d = result.dispatch;
          if (d?.started) toast.success("Approved — Claude is planning the fix (watch it in Progress / logs)");
          else if (d?.skipped) toast.success("Approved (dispatch not configured — run skipped)");
          else toast.error(`Approved, but dispatch failed: ${d?.error ?? "unknown error"}`);
        } else {
          toast.success(`Marked as ${STATUS_COPY[status].label.toLowerCase()}`);
        }
        await queryClient.invalidateQueries({ queryKey: ["feedback", "list"] });
      } catch (err) {
        // The approve never landed — release the latch so the queue can retry it.
        if (heavy) setDispatchingId(null);
        toast.error(toApiErrorMessage(err, "Failed to update feedback"));
      } finally {
        setBusyId(null);
      }
    },
    [queryClient],
  );

  // Reviewer verdict on a dispatched entry after testing the preview.
  // `validated` → keep the commit on staging (accepted, awaiting publish);
  // `not_fixed` → revert + re-dispatch Claude with the note.
  const validate = useCallback(
    async (id: string, action: "validated" | "not_fixed") => {
      const note = (notes[id] ?? "").trim();
      if (action === "not_fixed" && !note) {
        toast.error("Add a note describing what's still broken so Claude can retry.");
        return;
      }
      const heavy = action === "not_fixed";
      setBusyId(id);
      if (heavy) setPipelinePending(true);
      try {
        await apiClient.patch<{ entry: FeedbackEntry }>(`/api/feedback/${id}`, {
          json: { action, reviewNote: note },
        });
        toast.success(
          action === "validated"
            ? "Accepted — staged for publish"
            : "Marked not fixed — re-dispatching Claude with your note",
        );
        setNotes((prev) => ({ ...prev, [id]: "" }));
        await queryClient.invalidateQueries({ queryKey: ["feedback", "list"] });
      } catch (err) {
        toast.error(toApiErrorMessage(err, "Failed to submit verdict"));
      } finally {
        setBusyId(null);
        if (heavy) setPipelinePending(false);
      }
    },
    [notes, queryClient],
  );

  // Approve now: dispatch immediately if the pipeline is idle, otherwise drop the
  // entry into the local queue (shown with a clock icon) so it starts on its own
  // once the current run finishes — no more hard-locked Approve button.
  const approveOrQueue = useCallback(
    (entry: FeedbackEntry) => {
      if (pipelineBusy) {
        setQueuedApprovals((prev) => (prev.includes(entry.id) ? prev : [...prev, entry.id]));
        toast.success("Queued — starts automatically when the current run finishes");
        return;
      }
      void updateStatus(entry.id, "approved");
    },
    [pipelineBusy, updateStatus],
  );

  const cancelQueued = useCallback(
    (id: string) => setQueuedApprovals((prev) => prev.filter((q) => q !== id)),
    [],
  );

  // Drain the queue one entry at a time. When nothing is running, dispatch the
  // first queued id that is still awaiting review; dispatching re-arms
  // `pipelineBusy` synchronously, so this effect bails until the run completes.
  useEffect(() => {
    if (pipelineBusy || queuedApprovals.length === 0) return;
    const stillQueued = queuedApprovals.filter((id) =>
      entries.some((e) => e.id === id && e.status === "new"),
    );
    const [nextId, ...rest] = stillQueued;
    if (nextId) {
      setQueuedApprovals(rest);
      void updateStatus(nextId, "approved");
    } else if (stillQueued.length !== queuedApprovals.length) {
      setQueuedApprovals(stillQueued); // prune entries that are no longer "new"
    }
  }, [pipelineBusy, queuedApprovals, entries, updateStatus]);

  // Confirm gates for the destructive / heavy actions.
  const requestDeny = useCallback((entry: FeedbackEntry) => setConfirmState({ kind: "deny", entry }), []);
  const requestRetry = useCallback(
    (entry: FeedbackEntry) => {
      if (!(notes[entry.id] ?? "").trim()) {
        toast.error("Add a note describing what's still broken so Claude can retry.");
        return;
      }
      setConfirmState({ kind: "retry", entry });
    },
    [notes],
  );

  const runConfirm = useCallback(() => {
    if (!confirmState) return;
    const { kind, entry } = confirmState;
    setConfirmState(null);
    if (kind === "deny") void updateStatus(entry.id, "rejected");
    else void validate(entry.id, "not_fixed");
  }, [confirmState, updateStatus, validate]);

  return (
    <PageScaffold
      title="Developer Feedback"
      subtitle="Review"
      description="Triage in-console reports. Approving an entry runs Claude (plan → validate → implement) and updates the shared staging/dev deployment with every accepted fix so far — accept or retry, then publish all accepted changes to live at once."
      loading={isLoading}
      isError={Boolean(error)}
      errorMessage={error ? toApiErrorMessage(error) : undefined}
      actions={
        canManage ? (
          <PublishButton
            acceptedCount={acceptedCount}
            acceptedTitles={acceptedTitles}
            pipelineBusy={pipelineBusy}
            onBusyChange={setPipelinePending}
          />
        ) : undefined
      }
    >
      <div className="space-y-3">
        <StagingBanner stagingUrl={stagingUrl} />
        <StatusLegend />

        {canManage && pipelineBusy && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            A pipeline action is already running — new approvals queue and start automatically; retry and publish wait until it finishes.
          </div>
        )}

        {entries.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageSquarePlus className="h-6 w-6 text-gray-300 dark:text-[#444]" />
            <p className="text-sm text-gray-500 dark:text-[#888]">No feedback yet.</p>
            <p className="max-w-sm text-xs text-gray-400 dark:text-[#555]">
              Reports submitted from the in-console “Report” button show up here for review.
            </p>
          </div>
        )}

        {entries.map((entry) => {
          const Icon = TYPE_ICON[entry.type];
          const busy = busyId === entry.id;
          const testLink = buildTestLink(entry);
          return (
            <div
              key={entry.id}
              className="rounded-xl border border-gray-200 bg-white p-4 dark:border-[#262626] dark:bg-[#161616]"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                  <span className="text-sm font-medium capitalize text-gray-900 dark:text-white">
                    {entry.type.replace("-", " ")}
                  </span>
                  {entry.severity && (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] capitalize text-gray-600 dark:bg-[#222] dark:text-[#aaa]">
                      {entry.severity}
                    </span>
                  )}
                </div>
                <StatusPill status={entry.status} />
              </div>

              <p className="mb-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-[#ccc]">{entry.description}</p>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-400 dark:text-[#666]">
                <span className="font-mono">{entry.pagePath}</span>
                <span>· {entry.createdBy}</span>
                <span>· {new Date(entry.createdAt).toLocaleString()}</span>
                {entry.reviewedBy && <span>· reviewed by {entry.reviewedBy}</span>}
              </div>

              {canManage ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {entry.status === "new" && (
                    <>
                      {queuedApprovals.includes(entry.id) ? (
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-300">
                          <Clock className="h-3.5 w-3.5" /> Queued — starts when the current run finishes
                          <button
                            type="button"
                            onClick={() => cancelQueued(entry.id)}
                            className="ml-1 text-amber-600/80 hover:text-amber-700 hover:underline dark:text-amber-300/80 dark:hover:text-amber-200"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          title={pipelineBusy ? "A run is in progress — this will be queued and start automatically" : undefined}
                          onClick={() => approveOrQueue(entry)}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : pipelineBusy ? (
                            <Clock className="h-3.5 w-3.5" />
                          ) : (
                            <Rocket className="h-3.5 w-3.5" />
                          )}
                          {pipelineBusy ? "Queue for Claude" : "Approve → Claude"}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => requestDeny(entry)}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <XCircle className="h-3.5 w-3.5" /> Deny
                      </button>
                    </>
                  )}
                  {entry.status === "approved" && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                      {STATUS_COPY.approved.label} plan → validate → implement → build…
                    </span>
                  )}
                  {entry.status === "dispatched" && (
                    <div className="w-full space-y-2">
                      {testLink ? (
                        <a
                          href={testLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                        >
                          <ExternalLink className="h-3.5 w-3.5" /> Test it here →{" "}
                          <span className="font-mono text-[10px] text-gray-400 dark:text-[#666]">
                            {entry.testPath || entry.pagePath}
                          </span>
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                          Updating staging deployment…
                        </span>
                      )}
                      <textarea
                        value={notes[entry.id] ?? ""}
                        onChange={(e) => setNotes((prev) => ({ ...prev, [entry.id]: e.target.value }))}
                        placeholder="If not fixed: describe what's still broken (sent to Claude on retry)…"
                        rows={2}
                        className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-700 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none dark:border-[#262626] dark:bg-[#111] dark:text-[#ccc] dark:placeholder:text-[#555]"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => validate(entry.id, "validated")}
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                          Accept (stage for publish)
                        </button>
                        <button
                          type="button"
                          disabled={busy || pipelineBusy}
                          title={pipelineBusy ? "A pipeline action is already running" : undefined}
                          onClick={() => requestRetry(entry)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <ThumbsDown className="h-3.5 w-3.5" /> Not fixed → retry
                        </button>
                      </div>
                    </div>
                  )}
                  {entry.status === "accepted" && (
                    <div className="flex w-full flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" /> {STATUS_COPY.accepted.label}
                      </span>
                      {testLink && (
                        <a
                          href={testLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                        >
                          <ExternalLink className="h-3 w-3" /> preview
                        </a>
                      )}
                    </div>
                  )}
                  {entry.status === "done" && entry.released && (
                    <span className="text-[11px] text-gray-500 dark:text-[#888]">
                      {STATUS_COPY.done.label}
                      {entry.publishedAt ? ` · ${new Date(entry.publishedAt).toLocaleString()}` : ""}
                    </span>
                  )}

                  {/* Live progress + audit history for this entry's dispatch runs. */}
                  {entry.status !== "new" && entry.status !== "rejected" && (
                    <div className="w-full">
                      <RunConsole feedbackId={entry.id} />
                    </div>
                  )}
                </div>
              ) : (
                entry.status === "new" && (
                  <p className="mt-3 text-[11px] italic text-gray-400 dark:text-[#555]">
                    Awaiting admin review (cluster:admin required to approve).
                  </p>
                )
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmState?.kind === "deny"}
        onConfirm={runConfirm}
        onCancel={() => setConfirmState(null)}
        title="Deny this report?"
        description="It will be marked denied and won't be worked on. You can't undo this from here."
        confirmText="Deny report"
        danger
      />
      <ConfirmDialog
        open={confirmState?.kind === "retry"}
        onConfirm={runConfirm}
        onCancel={() => setConfirmState(null)}
        title="Send back to Claude for a retry?"
        description="This reverts the staged change and re-runs Claude with your note (~15 min). The staging environment updates when it finishes."
        confirmText="Revert & retry"
        danger
      />
    </PageScaffold>
  );
}

export default FeedbackReview;
