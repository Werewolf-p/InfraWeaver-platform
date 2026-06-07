"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bug, CheckCircle2, ExternalLink, Lightbulb, Rocket, StickyNote, ThumbsDown, XCircle } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { apiClient, toApiErrorMessage } from "@/lib/api-client";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useRBAC } from "@/hooks/use-rbac";
import { RunConsole } from "@/components/feedback/run-console";
import { PublishButton } from "@/components/feedback/publish-button";

type FeedbackType = "bug" | "feature-request" | "note";
type FeedbackStatus = "new" | "approved" | "dispatched" | "accepted" | "done" | "rejected";

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

const TYPE_ICON: Record<FeedbackType, typeof Bug> = {
  bug: Bug,
  "feature-request": Lightbulb,
  note: StickyNote,
};

const STATUS_STYLE: Record<FeedbackStatus, string> = {
  new: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  approved: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  dispatched: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
  accepted: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  done: "bg-gray-100 text-gray-600 dark:bg-[#222] dark:text-[#aaa]",
  rejected: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
};

/** Deep-link into the preview at the reported page (previewUrl + testPath). */
function buildTestLink(entry: FeedbackEntry): string | null {
  if (!entry.previewUrl) return null;
  try {
    return new URL(entry.testPath || entry.pagePath || "/", entry.previewUrl).toString();
  } catch {
    return entry.previewUrl;
  }
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

  const { data, isLoading, error } = useQuery({
    queryKey: ["feedback", "list"],
    queryFn: () => apiClient.get<{ entries: FeedbackEntry[] }>("/api/feedback"),
    // Auto-refresh so status transitions (reconciled by the background dispatch
    // run) show without a manual reload.
    refetchInterval: 10_000,
  });

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const acceptedCount = useMemo(() => entries.filter((e) => e.status === "accepted").length, [entries]);

  const updateStatus = useCallback(
    async (id: string, status: FeedbackStatus) => {
      setBusyId(id);
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
          toast.success(`Marked as ${status}`);
        }
        await queryClient.invalidateQueries({ queryKey: ["feedback", "list"] });
      } catch (err) {
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
      setBusyId(id);
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
      }
    },
    [notes, queryClient],
  );

  return (
    <PageScaffold
      title="Developer Feedback"
      subtitle="Review"
      description="Triage in-console reports. Approving an entry runs Claude (plan → validate → implement), builds a preview, and lets you accept or retry — then publish all accepted changes to main."
      loading={isLoading}
      isError={Boolean(error)}
      errorMessage={error ? toApiErrorMessage(error) : undefined}
      actions={canManage ? <PublishButton acceptedCount={acceptedCount} /> : undefined}
    >
      <div className="space-y-3">
        {entries.length === 0 && (
          <p className="py-10 text-center text-sm text-gray-400 dark:text-[#555]">No feedback submitted yet.</p>
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
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium capitalize", STATUS_STYLE[entry.status])}>
                  {entry.status}
                </span>
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
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => updateStatus(entry.id, "approved")}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                      >
                        <Rocket className="h-3.5 w-3.5" /> Approve → Claude
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => updateStatus(entry.id, "rejected")}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d] disabled:opacity-60"
                      >
                        <XCircle className="h-3.5 w-3.5" /> Deny
                      </button>
                    </>
                  )}
                  {entry.status === "approved" && (
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                      Claude is working — plan → validate → implement → build…
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
                          Building preview deployment…
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
                          className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" /> Accept (stage for publish)
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => validate(entry.id, "not_fixed")}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10 disabled:opacity-60"
                        >
                          <ThumbsDown className="h-3.5 w-3.5" /> Not fixed → retry
                        </button>
                      </div>
                    </div>
                  )}
                  {entry.status === "accepted" && (
                    <div className="flex w-full flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Accepted — on feedback/staging, awaiting publish
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
                      Released to prod{entry.publishedAt ? ` · ${new Date(entry.publishedAt).toLocaleString()}` : ""}
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
    </PageScaffold>
  );
}

export default FeedbackReview;
