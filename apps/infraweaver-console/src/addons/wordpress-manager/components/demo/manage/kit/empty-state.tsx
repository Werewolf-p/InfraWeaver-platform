"use client";

/**
 * Centered dashed-border empty state — the richer sibling of panel-shell's
 * `PanelEmpty` (which is a one-line message). Adds an optional icon, a title, a
 * body and an action slot so a panel can invite the operator to do something when
 * there is nothing to show yet.
 */

import type { ElementType, JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  readonly icon?: ElementType;
  readonly title: string;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700",
        className,
      )}
    >
      {Icon ? (
        <span className="grid h-10 w-10 place-items-center rounded-full border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-500">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      ) : null}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
      {body ? <div className="max-w-prose text-xs text-zinc-500 dark:text-zinc-400">{body}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
