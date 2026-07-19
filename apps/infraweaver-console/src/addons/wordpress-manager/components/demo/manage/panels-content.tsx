"use client";

// Content tab for the per-site "Manage" demo — posts/pages counts, recent content, calendar, housekeeping.
import { CalendarClock, Clock, File, FileText, Image as ImageIcon, PencilLine, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, StatTile } from "../widgets";
import { DummyBadge } from "../DummyBadge";

type PillTone = "good" | "info" | "warn" | "critical" | "neutral";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const PILL: Record<PillTone, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY = "border-sky-500 bg-sky-500 text-white hover:bg-sky-600 dark:text-white";
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const demo = () => toast.info("Demo — no changes are made to the live site.");
const fmt = (n: number) => n.toLocaleString("en-US");

const STATUS_TONE: Record<"published" | "draft" | "scheduled" | "pending", PillTone> = {
  published: "good",
  draft: "neutral",
  scheduled: "info",
  pending: "warn",
};
const STATUS_LABEL: Record<"published" | "draft" | "scheduled" | "pending", string> = {
  published: "Published",
  draft: "Draft",
  scheduled: "Scheduled",
  pending: "Pending",
};

export function ContentPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { content } = ext;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
        <StatTile label="Posts" value={content.posts} icon={FileText} />
        <StatTile label="Pages" value={content.pages} icon={File} />
        <StatTile label="Drafts" value={content.drafts} icon={PencilLine} />
        <StatTile label="Media items" value={content.media} icon={ImageIcon} />
      </div>

      <SectionCard
        className="lg:col-span-2"
        title="Recent content"
        description="Latest posts and pages across this site."
        icon={FileText}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Title</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Author</th>
                <th className="py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {content.recent.map((item, i) => (
                <tr key={`${item.title}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-medium text-zinc-900 dark:text-zinc-100">{item.title}</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL_BASE, PILL[item.type === "post" ? "info" : "neutral"])}>{item.type}</span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL_BASE, PILL[STATUS_TONE[item.status]])}>{STATUS_LABEL[item.status]}</span>
                  </td>
                  <td className="py-2 pr-4">{item.author}</td>
                  <td className="py-2 text-zinc-500 dark:text-zinc-400">{item.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4">
          <button type="button" onClick={demo} className={cn(BTN, BTN_PRIMARY)}>
            <Plus className="h-4 w-4" aria-hidden /> New post
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Publishing calendar"
        description="Content scheduled to go live soon."
        icon={CalendarClock}
        action={<DummyBadge />}
      >
        {content.upcoming.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nothing scheduled — the queue is clear.
          </div>
        ) : (
          <ul className="space-y-2">
            {content.upcoming.map((u, i) => (
              <li key={`${u.title}-${i}`} className={cn("flex items-center gap-3", TILE)}>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                  <Clock className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-900 dark:text-zinc-100">{u.title}</span>
                <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{u.when}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Housekeeping"
        description="Reclaim space and keep the editor tidy."
        icon={Trash2}
        action={<DummyBadge />}
      >
        <div className={cn("flex items-center justify-between gap-3", TILE)}>
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Old revisions</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="tabular-nums">{fmt(content.revisionsCleanable)}</span> revisions can be cleaned up.
            </p>
          </div>
          <button type="button" onClick={demo} className={BTN}>
            <Trash2 className="h-4 w-4" aria-hidden /> Clean revisions
          </button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className={TILE}>
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Drafts</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{content.drafts}</p>
          </div>
          <div className={TILE}>
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Pending review</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{content.pending}</p>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
