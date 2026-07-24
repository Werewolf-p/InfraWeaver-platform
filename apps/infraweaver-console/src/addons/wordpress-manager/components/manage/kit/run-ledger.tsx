"use client";

/**
 * `RunLedger` — the per-item progress view for a bulk run. Extracted and
 * generalized from `fleet-bulk-toolbar.tsx` (which rendered a per-SITE list): a
 * progress bar + one row per item with a status glyph and message. Purely
 * presentational; it renders whatever `lib/manage/run-ledger.ts` produces.
 */

import type { ElementType } from "react";
import { CheckCircle2, CircleDashed, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { completedCount, summarize, type ItemRun, type RunStatus } from "../../../lib/manage/run-ledger";

const STATUS_ICON: Record<RunStatus, ElementType> = {
  pending: CircleDashed,
  running: Loader2,
  ok: CheckCircle2,
  error: XCircle,
};

/** A single status glyph, coloured + spun by state. Colour never rides alone (icon shape differs). */
export function StatusIcon({ status }: { status: RunStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Icon
      className={cn(
        "h-4 w-4 shrink-0",
        status === "ok" && "text-emerald-500 dark:text-emerald-400",
        status === "error" && "text-red-500 dark:text-red-400",
        status === "running" && "animate-spin text-sky-500 dark:text-sky-400",
        status === "pending" && "text-zinc-400 dark:text-zinc-500",
      )}
      aria-hidden
    />
  );
}

export interface RunLedgerProps {
  readonly runs: readonly ItemRun[];
  readonly running: boolean;
  /** Friendly label for an item id (defaults to the id itself). */
  readonly itemLabel?: (id: string) => string;
}

export function RunLedger({ runs, running, itemLabel }: RunLedgerProps) {
  const summary = summarize(runs);
  const done = completedCount(runs);
  const total = runs.length;

  return (
    <div className="space-y-4">
      <div role="status" aria-live="polite" className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-700 dark:text-zinc-300">
            {running
              ? `Working… ${done}/${total}`
              : summary.failed === 0
                ? `Done — all ${total} succeeded`
                : `Done — ${summary.ok} succeeded, ${summary.failed} failed`}
          </span>
          {running ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" aria-hidden /> : null}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-300",
              summary.failed > 0 && !running ? "bg-amber-500" : "bg-sky-500",
            )}
            style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
          />
        </div>
      </div>

      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {runs.map((run) => (
          <li
            key={run.id}
            className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm dark:border-zinc-800"
          >
            <StatusIcon status={run.status} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
              {itemLabel ? itemLabel(run.id) : run.id}
            </span>
            {run.message ? (
              <span
                className={cn(
                  "shrink-0 truncate text-xs",
                  run.status === "error" ? "text-red-500 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400",
                )}
                title={run.message}
              >
                {run.message}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
