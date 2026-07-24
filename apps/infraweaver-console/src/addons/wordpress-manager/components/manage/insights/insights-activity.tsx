"use client";

// Admin-activity stream for the Logs panel — the site's metadata-only activity
// trail (publishes, logins, plugin toggles, watched setting changes) over the
// signed `activity.log` method, newest-first. Read-only in the console (clearing
// stays a deliberate on-site act). Degrades honestly: an un-entitled site shows
// the locked teaser, an old connector the update prompt — while the panel's
// server-log half keeps working for every site.

import { UserCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ACTIVITY_DEFAULT_LIMIT, type ActivityEntry, type ActivityLogResponse } from "../../../lib/manage/insights";
import { deriveInsightsView } from "../../../lib/manage/insights-format";
import { useActivityLog } from "../../../lib/manage/use-insights";
import { InsightsErrorState, InsightsLoading, InsightsLocked, InsightsTooOld } from "./insights-states";

const WHAT = "Admin activity trail";

/** Relative "Xm ago" from unix seconds; falls back to an ISO date for old entries. */
function relativeTime(atSeconds: number): string {
  const deltaMs = Date.now() - atSeconds * 1000;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(atSeconds * 1000).toISOString().slice(0, 10);
}

const ACTION_TONE = "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300";

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <UserCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{entry.actor || "unknown"}</span>
          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", ACTION_TONE)}>
            {entry.action || "activity"}
          </span>
          {entry.object ? <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{entry.object}</span> : null}
        </div>
        {entry.summary ? <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{entry.summary}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">{relativeTime(entry.at)}</span>
    </li>
  );
}

/** The admin-activity stream — self-fetching. Renders under the server-log stream. */
export function InsightsActivity({ site }: { site: string }) {
  const query = useActivityLog(site, ACTIVITY_DEFAULT_LIMIT);
  const view = deriveInsightsView<ActivityLogResponse>({
    isLoading: query.isLoading,
    data: query.data,
    error: query.error,
  });

  if (view.kind === "loading") return <InsightsLoading rows={4} />;
  if (view.kind === "too-old") return <InsightsTooOld what={WHAT} />;
  if (view.kind === "error") return <InsightsErrorState message={view.message} />;
  if (view.kind === "locked") {
    return <InsightsLocked reason={view.reason} upsell={view.upsell} tier={view.tier} what={WHAT} />;
  }

  const entries = view.data.entries ?? [];
  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        No admin activity recorded yet.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry, i) => (
        <ActivityRow key={`${entry.at}-${i}`} entry={entry} />
      ))}
    </ul>
  );
}
