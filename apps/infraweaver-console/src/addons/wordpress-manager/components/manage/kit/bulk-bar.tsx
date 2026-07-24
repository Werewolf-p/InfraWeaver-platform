"use client";

/**
 * `BulkActionBar` — the in-panel counterpart to the fleet toolbar. A sticky bar
 * that appears when the selection is non-empty ("N selected · [actions] · Clear")
 * and fans a chosen action across the selected ids with a live per-item ledger.
 *
 * Reuses the accessible `Modal` + `ConfirmDialog` from the Manage kit (so focus,
 * typed confirmation and the zinc/sky language match) and the shared `RunLedger`
 * for progress. Destructive actions confirm through `ConfirmDialog`; never an
 * armed-button hack. Execution is bounded-concurrency sequential with a summary
 * toast at the end — the same contract as `fleet-bulk-toolbar.tsx`, generalized
 * to arbitrary ids.
 */

import { useCallback, useEffect, useRef, useState, type ElementType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { EASE_OUT } from "../../demo/motion";
import { ConfirmDialog, Modal } from "../../demo/manage/manage-ui";
import { RunLedger } from "./run-ledger";
import { initLedger, runItems, summarize, type ItemOutcome, type ItemRun } from "../../../lib/manage/run-ledger";

/** One offered bulk action. Mirrors the fleet toolbar's meta shape, id-generic. */
export interface BulkActionMeta {
  readonly id: string;
  readonly label: string;
  readonly icon?: ElementType;
  /** Render the trigger + confirm in the destructive (red) idiom. */
  readonly danger?: boolean;
  /** Show a confirm dialog listing the target count before running. */
  readonly confirm?: boolean;
  readonly confirmTitle?: (count: number) => string;
  readonly description?: string;
  /** Typed-confirmation phrase for irreversible actions (e.g. "delete"). */
  readonly confirmPhrase?: string;
}

export interface BulkActionBarProps {
  readonly count: number;
  /** Selected ids in display order — the fan-out targets. */
  readonly ids: readonly string[];
  readonly actions: readonly BulkActionMeta[];
  /** Runs ONE item for an action; returns the ledger outcome. */
  readonly runItem: (actionId: string, id: string) => Promise<ItemOutcome>;
  readonly onClear: () => void;
  /** Called once after a batch finishes (invalidate queries here). */
  readonly onComplete?: (actionId: string) => void;
  readonly concurrency?: number;
  readonly itemLabel?: (id: string) => string;
}

interface ActiveRun {
  readonly action: BulkActionMeta;
  readonly phase: "confirm" | "running" | "done";
  readonly runs: readonly ItemRun[];
}

export function BulkActionBar({
  count,
  ids,
  actions,
  runItem,
  onClear,
  onComplete,
  concurrency = 3,
  itemLabel,
}: BulkActionBarProps) {
  const [active, setActive] = useState<ActiveRun | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const safeSet = useCallback((update: (prev: ActiveRun | null) => ActiveRun | null) => {
    if (mounted.current) setActive(update);
  }, []);

  const running = active?.phase === "running";

  const startRun = useCallback(
    async (action: BulkActionMeta) => {
      const targets = [...ids];
      if (targets.length === 0) return;
      safeSet(() => ({ action, phase: "running", runs: initLedger(targets) }));
      const finalLedger = await runItems(
        targets,
        (id) => runItem(action.id, id),
        (ledger) => safeSet((prev) => (prev ? { ...prev, runs: ledger } : prev)),
        concurrency,
      );
      const summary = summarize(finalLedger);
      if (summary.failed === 0) toast.success(`${action.label}: ${summary.ok}/${summary.total} succeeded`);
      else if (summary.ok === 0) toast.error(`${action.label}: all ${summary.failed} failed`);
      else toast.warning(`${action.label}: ${summary.ok} succeeded, ${summary.failed} failed`);
      safeSet((prev) => (prev ? { ...prev, phase: "done", runs: finalLedger } : prev));
      onComplete?.(action.id);
    },
    [ids, runItem, concurrency, safeSet, onComplete],
  );

  const beginAction = useCallback(
    (action: BulkActionMeta) => {
      if (ids.length === 0) return;
      if (action.confirm || action.confirmPhrase) setActive({ action, phase: "confirm", runs: [] });
      else void startRun(action);
    },
    [ids.length, startRun],
  );

  const closeDialog = useCallback(() => {
    if (mounted.current) setActive(null);
  }, []);

  return (
    <>
      <AnimatePresence initial={false}>
        {count > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="sticky bottom-3 z-10 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2.5 shadow-sm backdrop-blur dark:bg-sky-500/10"
          >
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100" aria-live="polite">
              {count} selected
            </span>
            <span className="mx-1 hidden h-4 w-px bg-zinc-300 sm:block dark:bg-zinc-700" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => beginAction(action)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500",
                      action.danger
                        ? "border-red-300 bg-white text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/40"
                        : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:text-white",
                    )}
                  >
                    {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
                    {action.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={onClear}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <X className="h-4 w-4" aria-hidden /> Clear
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {active && active.phase === "confirm" ? (
        <ConfirmDialog
          open
          onClose={closeDialog}
          onConfirm={() => void startRun(active.action)}
          title={active.action.confirmTitle?.(ids.length) ?? `${active.action.label} — ${ids.length} selected?`}
          description={active.action.description}
          confirmLabel={active.action.label}
          confirmPhrase={active.action.confirmPhrase}
          tone={active.action.danger ? "danger" : "neutral"}
        />
      ) : null}

      <Modal
        open={active !== null && active.phase !== "confirm"}
        onClose={running ? () => undefined : closeDialog}
        title={active ? active.action.label : ""}
        description={active?.action.description}
        icon={active?.action.icon}
      >
        {active ? <RunLedger runs={active.runs} running={running} itemLabel={itemLabel} /> : null}
        {active && !running ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={closeDialog}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-sky-500 bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50"
            >
              Close
            </button>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
