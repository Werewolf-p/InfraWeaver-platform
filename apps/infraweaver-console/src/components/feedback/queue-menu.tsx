"use client";

import { ArrowDown, ArrowUp, Clock, ListOrdered, Trash2 } from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";

/** One entry waiting in the approval queue, in dispatch order. */
export interface QueuedItem {
  id: string;
  summary: string;
}

interface QueueMenuProps {
  open: boolean;
  onClose: () => void;
  /** Queued entries in the order they will be dispatched (index 0 is next). */
  items: readonly QueuedItem[];
  /** Whether a run is currently in flight (so the head item is "next up"). */
  pipelineBusy: boolean;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onCancel: (id: string) => void;
}

/**
 * Approval queue manager — a popup listing every queued feedback entry in
 * dispatch order, with controls to reorder (move up/down) or cancel each one.
 * Reordering only changes the local dispatch *preference*; the backend still
 * serializes runs and re-validates authorization when each item is dispatched.
 */
export function QueueMenu({
  open,
  onClose,
  items,
  pipelineBusy,
  onMoveUp,
  onMoveDown,
  onCancel,
}: QueueMenuProps) {
  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      size="sm"
      title="Approval queue"
      description={
        pipelineBusy
          ? "A run is in progress. These entries dispatch one at a time, top first, as it frees up."
          : "These entries dispatch one at a time, top first. Reorder to choose what Claude works on next."
      }
    >
      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <ListOrdered className="h-6 w-6 text-gray-300 dark:text-[#444]" />
          <p className="text-sm text-gray-500 dark:text-[#888]">The queue is empty.</p>
          <p className="max-w-xs text-xs text-gray-400 dark:text-[#555]">
            Approving an entry while a run is in progress adds it here, and it starts automatically when the
            pipeline frees up.
          </p>
        </div>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => {
            const isFirst = index === 0;
            const isLast = index === items.length - 1;
            return (
              <li
                key={item.id}
                className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-[#262626] dark:bg-[#161616]"
              >
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600 dark:bg-[#222] dark:text-[#aaa]">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-gray-700 dark:text-[#ccc]">{item.summary}</p>
                  {isFirst && (
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-300">
                      <Clock className="h-3 w-3" /> {pipelineBusy ? "Next up" : "Starting…"}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={isFirst}
                    onClick={() => onMoveUp(item.id)}
                    aria-label={`Move "${item.summary}" up`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d]"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={isLast}
                    onClick={() => onMoveDown(item.id)}
                    aria-label={`Move "${item.summary}" down`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#262626] dark:text-[#888] dark:hover:bg-[#1d1d1d]"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onCancel(item.id)}
                    aria-label={`Remove "${item.summary}" from the queue`}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-rose-200 text-rose-500 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </ResponsiveSheet>
  );
}

export default QueueMenu;
