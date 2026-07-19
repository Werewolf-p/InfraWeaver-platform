"use client";
// Content panel — post / page / draft / comment / revision counts and recent
// posts, all read live from the site. Read-only: no content mutation is exposed
// through the allow-listed Manage actions, so this panel renders no write buttons.

import { CalendarClock, File, FileText, History, MessageSquare, PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentData, RecentPost } from "../../../lib/manage/probes/content";
import { SectionCard, StatTile } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

type StatusKey = "published" | "draft" | "scheduled" | "pending" | "other";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const PILL: Record<StatusKey, string> = {
  published: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  scheduled: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  draft: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
  other: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const STATUS_META: Record<string, { key: StatusKey; label: string }> = {
  publish: { key: "published", label: "Published" },
  future: { key: "scheduled", label: "Scheduled" },
  pending: { key: "pending", label: "Pending" },
  draft: { key: "draft", label: "Draft" },
};

function statusMeta(status: string): { key: StatusKey; label: string } {
  return STATUS_META[status] ?? { key: "other", label: status };
}

/** Show the date portion of a `YYYY-MM-DD HH:MM:SS` wp-cli timestamp. */
function shortDate(value: string | null): string {
  if (!value) return "—";
  return value.split(" ")[0] || value;
}

function RecentRow({ item }: { item: RecentPost }) {
  const meta = statusMeta(item.status);
  return (
    <tr className="text-zinc-700 dark:text-zinc-300">
      <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{item.title}</td>
      <td className="py-2 pr-4">
        <span className={cn(PILL_BASE, PILL[meta.key])}>{meta.label}</span>
      </td>
      <td className="py-2 text-zinc-500 dark:text-zinc-400">{shortDate(item.date)}</td>
    </tr>
  );
}

export function ContentPanel({ site }: { site: string }) {
  const state = useManagePanel<ContentData>(site, "content");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
            <StatTile label="Posts" value={data.posts} icon={FileText} />
            <StatTile label="Pages" value={data.pages} icon={File} />
            <StatTile label="Drafts" value={data.drafts} icon={PencilLine} />
            <StatTile label="Comments" value={data.comments} icon={MessageSquare} />
          </div>

          <SectionCard
            className="lg:col-span-2"
            title="Recent posts"
            description="The most recently created posts on this site."
            icon={FileText}
          >
            {data.recent.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                No posts yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4 font-medium">Title</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.recent.map((item, i) => (
                      <RecentRow key={`${item.title}-${i}`} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard title="Comment queue" description="Moderation backlog across all posts." icon={MessageSquare}>
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
          </SectionCard>

          <SectionCard title="Editorial" description="Drafts and stored revisions." icon={CalendarClock}>
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
      )}
    </PanelState>
  );
}
