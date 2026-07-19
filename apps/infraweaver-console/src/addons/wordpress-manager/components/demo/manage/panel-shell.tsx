"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";

const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

/** Skeleton shown while a panel's live data is loading. */
export function PanelSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100/70 dark:border-zinc-800 dark:bg-zinc-800/40"
        />
      ))}
    </div>
  );
}

/** Error card with a retry affordance for a failed panel fetch. */
export function PanelError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-8 text-center">
      <AlertTriangle className="h-6 w-6 text-amber-500" aria-hidden />
      <p className="max-w-prose text-sm text-zinc-600 dark:text-zinc-300">{message}</p>
      <button type="button" className={BTN} onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden /> Retry
      </button>
    </div>
  );
}

/** Neutral empty state for a panel that loaded but has nothing to show. */
export function PanelEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
      <Inbox className="h-5 w-5" aria-hidden />
      {message}
    </div>
  );
}

/** Inline spinner used inside buttons while an action runs. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={className ?? "h-4 w-4 animate-spin"} aria-hidden />;
}

/**
 * Render-state gate for a panel: shows a skeleton while loading, an error card on
 * failure, an empty state when `isEmpty`, otherwise the panel body. Keeps every
 * panel's loading/error/empty handling identical.
 */
export function PanelState<T>({
  state,
  isEmpty,
  emptyMessage = "Nothing to show yet.",
  children,
}: {
  state: { data: T | null; loading: boolean; error: string | null; reload(): void };
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  children: (data: T) => ReactNode;
}): ReactNode {
  if (state.error) return <PanelError message={state.error} onRetry={state.reload} />;
  if (state.loading && state.data === null) return <PanelSkeleton />;
  if (state.data === null) return <PanelSkeleton />;
  if (isEmpty?.(state.data)) return <PanelEmpty message={emptyMessage} />;
  return <>{children(state.data)}</>;
}
