"use client";
// Content panel — post / page / draft / comment / revision counts and recent
// posts, read live from the site. Actionable: moderate the pending comment queue
// (approve / spam / trash) and manage a post by id (trash / restore / permanently
// delete). WordPress core exposes no post id in the recent-post snapshot, so
// per-post actions are keyed by a typed id; the queue actions need no id.

import { useState } from "react";
import { CalendarClock, Check, File, FileText, Hash, History, MessageSquare, PencilLine, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentData, RecentPost } from "../../../lib/manage/probes/content";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState, Spinner } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { ActionError, BTN, BTN_SM, BTN_DANGER_GHOST, ConfirmDialog, Field, INPUT, useActionRunner } from "./manage-ui";
import { parseId } from "./form-validation";
import { DataTable, EmptyState, Pill, type Column, type PillTone } from "./kit";

type StatusKey = "published" | "draft" | "scheduled" | "pending" | "other";
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

/** Above-this pending count paints the Comments tile amber — a backlog is the actionable thing. */
const HEALTHY_SCORE = 90;
const WARN_SCORE = 55;

const STATUS_META: Record<string, { readonly key: StatusKey; readonly label: string }> = {
  publish: { key: "published", label: "Published" },
  future: { key: "scheduled", label: "Scheduled" },
  pending: { key: "pending", label: "Pending" },
  draft: { key: "draft", label: "Draft" },
};

const STATUS_TONE: Readonly<Record<StatusKey, PillTone>> = {
  published: "good",
  scheduled: "info",
  pending: "warn",
  draft: "neutral",
  other: "neutral",
};

function statusMeta(status: string): { readonly key: StatusKey; readonly label: string } {
  return STATUS_META[status] ?? { key: "other", label: status };
}

function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.split(" ")[0] || value;
}

const RECENT_COLUMNS: readonly Column<RecentPost>[] = [
  {
    key: "title",
    header: "Title",
    render: (item) => <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.title}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (item) => {
      const meta = statusMeta(item.status);
      return <Pill tone={STATUS_TONE[meta.key]}>{meta.label}</Pill>;
    },
  },
  {
    key: "date",
    header: "Created",
    align: "right",
    render: (item) => <span className="text-zinc-500 dark:text-zinc-400">{shortDate(item.date)}</span>,
  },
];

/** Manage a single post by numeric id — trash, restore to draft, or permanently delete. */
function PostByIdCard({ site, onChanged }: { site: string; onChanged: () => void }) {
  const { run, pending, error, clearError } = useActionRunner(site);
  const [idText, setIdText] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const postId = parseId(idText);
  const ready = postId !== null && !pending;

  async function trash() {
    if (postId === null) return;
    await run({ type: "trash-post", postId }, { onSuccess: onChanged });
  }
  async function restore() {
    if (postId === null) return;
    await run({ type: "untrash-post", postId }, { onSuccess: onChanged });
  }
  async function confirmDelete() {
    if (postId === null) return;
    const result = await run({ type: "delete-post", postId }, { onSuccess: onChanged });
    if (result.ok) {
      setDeleteOpen(false);
      setIdText("");
    }
  }

  return (
    <SectionCard
      title="Manage a single post"
      description="Move one post to the trash, bring it back, or delete it for good."
      icon={Hash}
    >
      <div className="space-y-3">
        <Field
          label="Post ID"
          htmlFor="post-id"
          hint="Every post has a number — you'll see it in the web address while editing that post (e.g. 42)."
        >
          <input
            id="post-id"
            inputMode="numeric"
            value={idText}
            onChange={(e) => {
              setIdText(e.target.value);
              clearError();
            }}
            className={INPUT}
            placeholder="Post ID"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={!ready} onClick={trash}>
            {pending ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Move to trash
          </button>
          <button type="button" className={BTN} disabled={!ready} onClick={restore}>
            <Undo2 className="h-4 w-4" aria-hidden /> Restore to draft
          </button>
          <button type="button" className={BTN_DANGER_GHOST} disabled={!ready} onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete permanently
          </button>
        </div>
        {error ? <ActionError message={error} onDismiss={clearError} /> : null}
      </div>
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={confirmDelete}
        title={`Permanently delete post ${postId ?? ""}?`}
        description="This bypasses the trash — the post cannot be recovered."
        confirmLabel="Delete permanently"
        confirmPhrase={postId !== null ? String(postId) : undefined}
        confirmPhraseLabel="Re-type the post ID to confirm"
        pending={pending}
        error={error}
      />
    </SectionCard>
  );
}

/** Moderate the pending comment queue (held comments) in bulk. Only rendered when a queue exists. */
function CommentModeration({ site, onChanged }: { site: string; onChanged: () => void }) {
  const { run, pending, error } = useActionRunner(site);

  async function moderate(action: "approve" | "spam" | "trash") {
    await run({ type: "moderate-comments", action, scope: "all" }, { onSuccess: onChanged });
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_SM} disabled={pending} onClick={() => moderate("approve")}>
          <Check className="h-3.5 w-3.5" aria-hidden /> Approve pending
        </button>
        <button type="button" className={BTN_SM} disabled={pending} onClick={() => moderate("spam")}>
          Mark pending spam
        </button>
        <button type="button" className={BTN_SM} disabled={pending} onClick={() => moderate("trash")}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Trash pending
        </button>
        {pending ? <Spinner /> : null}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">Acts on every comment currently held for moderation.</p>
      {error ? <ActionError message={error} /> : null}
    </div>
  );
}

export function ContentPanel({ site }: { site: string }) {
  const state = useManagePanel<ContentData>(site, "content");

  return (
    <PanelState state={state}>
      {(data) => {
        const hasQueue = data.pendingComments > 0;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
              <StatTile label="Posts" value={data.posts} icon={FileText} />
              <StatTile label="Pages" value={data.pages} icon={File} />
              <StatTile label="Drafts" value={data.drafts} icon={PencilLine} />
              <StatTile
                label="Comments"
                value={data.comments}
                icon={MessageSquare}
                tone={healthTone(hasQueue ? WARN_SCORE : HEALTHY_SCORE)}
              />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Recent posts"
              description="The most recently created posts on this site."
              icon={FileText}
            >
              {data.recent.length === 0 ? (
                <EmptyState icon={FileText} title="No posts yet." body="New posts will appear here once they're created." />
              ) : (
                <DataTable
                  caption="Recent posts on this site, with status and creation date"
                  columns={RECENT_COLUMNS}
                  rows={data.recent}
                  getRowKey={(item, index) => `${item.title}-${index}`}
                />
              )}
            </SectionCard>

            <SectionCard title="Comment queue" description="Comments waiting for your review." icon={MessageSquare}>
              {hasQueue ? (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className={TILE}>
                      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Total</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.comments}</p>
                    </div>
                    <div className={TILE}>
                      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Pending</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-amber-600 dark:text-amber-400">{data.pendingComments}</p>
                    </div>
                    <div className={TILE}>
                      <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Spam</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">{data.spamComments}</p>
                    </div>
                  </div>
                  <CommentModeration site={site} onChanged={state.reload} />
                </>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No comments awaiting moderation.</p>
              )}
            </SectionCard>

            <PostByIdCard site={site} onChanged={state.reload} />

            <SectionCard title="Editorial" description="Drafts and stored revisions." icon={CalendarClock} className="lg:col-span-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className={cn("flex items-center gap-3", TILE)}>
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-500/10 text-zinc-600 dark:text-zinc-400">
                    <PencilLine className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Drafts</p>
                    <p className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.drafts}</p>
                  </div>
                </div>
                <div className={cn("flex items-center gap-3", TILE)}>
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                    <History className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Revisions stored</p>
                    <p className="text-xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.revisions}</p>
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
