"use client";

/**
 * Red-bordered wrapper that visually fences off destructive actions. Layout only —
 * the actual confirmation still goes through manage-ui's `ConfirmDialog` (typed
 * confirmation) and the server's 409 guardrails. Consolidates the "Danger zone"
 * block the People/Settings dialogs each hand-rolled.
 */

import type { JSX, ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

export interface DangerZoneProps {
  readonly title?: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}

export function DangerZone({ title = "Danger zone", description, children }: DangerZoneProps): JSX.Element {
  return (
    <div className="space-y-2 rounded-xl border border-red-500/30 bg-red-500/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-300">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden /> {title}
      </div>
      {description ? <p className="text-xs text-red-700/90 dark:text-red-300/90">{description}</p> : null}
      {children}
    </div>
  );
}
