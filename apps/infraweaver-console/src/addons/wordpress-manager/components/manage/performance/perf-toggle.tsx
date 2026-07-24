"use client";

/**
 * `Toggle` — an accessible on/off switch (role="switch") the Performance surface
 * uses for the page-cache, speed-pack and lazy-load settings. Each toggle carries a
 * one-line benefit and an optional risk chip so a non-technical owner understands
 * the impact before flipping it (US-10). Controlled; the parent owns the value.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Pill } from "../../demo/manage/kit";

export interface ToggleProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  /** One-line plain-language benefit shown under the label. */
  readonly impact?: string;
  /** A short warning chip (e.g. "Advanced") rendered beside the label. */
  readonly risk?: string;
  /** An extra note (e.g. a manual step) rendered under the impact line. */
  readonly note?: ReactNode;
}

export function Toggle({ label, checked, onChange, disabled, impact, risk, note }: ToggleProps): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
          {risk ? (
            <Pill tone="warn" className="text-[10px]">
              {risk}
            </Pill>
          ) : null}
        </div>
        {impact ? <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{impact}</p> : null}
        {note ? <div className="mt-1">{note}</div> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-sky-500" : "bg-zinc-300 dark:bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4.5" : "translate-x-1",
          )}
          aria-hidden
        />
      </button>
    </div>
  );
}
