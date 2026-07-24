"use client";

// Shared presentational states for the Insights surface: the honest locked/upsell
// teaser (renders the connector's real gate reason, never fake numbers), the
// connector-too-old update prompt, and a compact loading shimmer. Reused by the
// traffic module and the admin-activity stream so both degrade identically.

import type { ReactNode } from "react";
import { ArrowUpCircle, Lock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

const CARD =
  "flex flex-col items-center gap-2 rounded-xl border border-dashed p-6 text-center text-sm";

/**
 * Locked/upsell teaser. An upsell (a tier gap) is styled invitingly (amber) and
 * points at the plan; a transient/link reason is neutral. Never renders numbers.
 */
export function InsightsLocked({
  reason,
  upsell,
  tier,
  what,
}: {
  reason: string;
  upsell: boolean;
  tier: string;
  what: string;
}) {
  return (
    <div
      className={cn(
        CARD,
        upsell
          ? "border-amber-500/40 bg-amber-500/5 text-zinc-700 dark:text-zinc-200"
          : "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400",
      )}
    >
      <Lock className={cn("h-6 w-6", upsell ? "text-amber-500" : "text-zinc-400")} aria-hidden />
      <p className="max-w-prose font-medium">{what}</p>
      <p className="max-w-prose text-xs">{reason}</p>
      {upsell ? (
        <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
          <ArrowUpCircle className="h-3.5 w-3.5" aria-hidden /> Included in {tier}
        </span>
      ) : null}
    </div>
  );
}

/** The installed connector predates the analytics command surface — prompt to update. */
export function InsightsTooOld({ what }: { what: string }) {
  return (
    <div className={cn(CARD, "border-sky-500/40 bg-sky-500/5 text-zinc-600 dark:text-zinc-300")}>
      <RefreshCw className="h-6 w-6 text-sky-500" aria-hidden />
      <p className="max-w-prose font-medium">{what}</p>
      <p className="max-w-prose text-xs">
        This site&apos;s connector is too old to report insights. Update the connector on the Plan &amp; connector
        tab to unlock it.
      </p>
    </div>
  );
}

/** A compact shimmer while an insight read is in flight. */
export function InsightsLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
      ))}
    </div>
  );
}

/** A retryable read error. */
export function InsightsErrorState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className={cn(CARD, "border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-300")}>
      <p className="max-w-prose">{message}</p>
      {children}
    </div>
  );
}
