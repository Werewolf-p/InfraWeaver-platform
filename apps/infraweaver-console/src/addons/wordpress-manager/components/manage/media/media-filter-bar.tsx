"use client";

/**
 * The Explorer toolbar: the flagship one-of filter (All / Not lossless / Not on
 * CDN), a MIME select, debounced search, and the load-bearing "select all
 * matching" control — the single gesture that, with "Not lossless" active,
 * selects the WHOLE matching set (not just the visible page) so "make every
 * non-lossless image lossless" is one click. The count it shows is the server's
 * true match total, so the selection is the query, not the page.
 */

import { useEffect, useState } from "react";
import { CheckSquare, Search } from "lucide-react";
import { FilterTabs } from "../../demo/manage/kit/filter-tabs";
import { Spinner } from "../../demo/manage/panel-shell";
import { MIME_GROUPS, type MimeGroup } from "../../../lib/manage/media";

/** The combined attention filter → (optimization, offload) predicates. */
export type AttentionFilter = "all" | "not-lossless" | "not-on-cdn";

export interface MediaFilterBarProps {
  readonly attention: AttentionFilter;
  readonly onAttentionChange: (value: AttentionFilter) => void;
  readonly mime: MimeGroup;
  readonly onMimeChange: (value: MimeGroup) => void;
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  /** Whether the optimization/offload filters apply (site entitled for image_optimization). */
  readonly optimizationEnabled: boolean;
  readonly counts?: { readonly notLossless?: number; readonly notOnCdn?: number };
  /** The server's true match total for the current filter (drives the select-all label). */
  readonly matchingCount: number;
  readonly onSelectAllMatching?: () => void;
  readonly selecting?: boolean;
}

const MIME_LABELS: Record<MimeGroup, string> = {
  all: "All types",
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
};

export function MediaFilterBar({
  attention,
  onAttentionChange,
  mime,
  onMimeChange,
  search,
  onSearchChange,
  optimizationEnabled,
  counts,
  matchingCount,
  onSelectAllMatching,
  selecting,
}: MediaFilterBarProps) {
  // Debounce the free-text search so each keystroke doesn't refetch the page.
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  useEffect(() => {
    const handle = setTimeout(() => {
      if (draft !== search) onSearchChange(draft);
    }, 300);
    return () => clearTimeout(handle);
  }, [draft, search, onSearchChange]);

  const tabs = optimizationEnabled
    ? ([
        { value: "all", label: "All" },
        { value: "not-lossless", label: "Not lossless", count: counts?.notLossless },
        { value: "not-on-cdn", label: "Not on CDN", count: counts?.notOnCdn },
      ] as const)
    : ([{ value: "all", label: "All" }] as const);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <FilterTabs
          options={tabs}
          value={attention}
          onChange={(v) => onAttentionChange(v as AttentionFilter)}
          ariaLabel="Filter assets by attention"
        />
        <label className="sr-only" htmlFor="media-mime">
          Media type
        </label>
        <select
          id="media-mime"
          value={mime}
          onChange={(e) => onMimeChange(e.target.value as MimeGroup)}
          className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
        >
          {MIME_GROUPS.map((g) => (
            <option key={g} value={g}>
              {MIME_LABELS[g]}
            </option>
          ))}
        </select>

        <div className="relative min-w-[10rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search filename or title"
            maxLength={200}
            aria-label="Search media"
            className="w-full rounded-lg border border-zinc-300 bg-white py-1.5 pl-8 pr-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      </div>

      {onSelectAllMatching && matchingCount > 0 ? (
        <button
          type="button"
          onClick={onSelectAllMatching}
          disabled={selecting}
          className="inline-flex w-fit items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/5 px-3 py-1.5 text-sm font-medium text-sky-700 transition-colors hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:opacity-60 dark:text-sky-300"
        >
          {selecting ? <Spinner className="h-4 w-4 animate-spin" /> : <CheckSquare className="h-4 w-4" aria-hidden />}
          Select all {matchingCount.toLocaleString()} {attention === "not-lossless" ? "non-lossless" : "matching"}
        </button>
      ) : null}
    </div>
  );
}
