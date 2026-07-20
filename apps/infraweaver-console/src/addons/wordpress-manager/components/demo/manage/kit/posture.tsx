"use client";

/**
 * Posture checklist primitives — consolidates the duplicated CHECK_ICON / list
 * markup and the good/recommended/critical legend that panels-security.tsx and
 * panels-health.tsx each hand-rolled. `PostureCheck` renders one `<li>` (wrap a set
 * in your own `<ul>`); `PostureSummary` renders the coloured legend + optional score.
 * State colour is always paired with an sr-only state word and an icon, never colour
 * alone.
 */

import type { ElementType, JSX, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type PostureState = "good" | "recommended" | "critical";

const POSTURE_ICON: Readonly<Record<PostureState, { readonly Icon: ElementType; readonly className: string }>> = {
  good: { Icon: CheckCircle2, className: "text-emerald-500" },
  recommended: { Icon: AlertTriangle, className: "text-amber-500" },
  critical: { Icon: XCircle, className: "text-red-500" },
};

const POSTURE_LABEL: Readonly<Record<PostureState, string>> = {
  good: "Good",
  recommended: "Recommended",
  critical: "Critical",
};

const POSTURE_DOT: Readonly<Record<PostureState, string>> = {
  good: "bg-emerald-500",
  recommended: "bg-amber-500",
  critical: "bg-red-500",
};

const POSTURE_VALUE_TEXT: Readonly<Record<PostureState, string>> = {
  good: "text-emerald-600 dark:text-emerald-400",
  recommended: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

export interface PostureCheckProps {
  readonly state: PostureState;
  readonly label: ReactNode;
  readonly detail?: ReactNode;
  readonly action?: ReactNode;
}

export function PostureCheck({ state, label, detail, action }: PostureCheckProps): JSX.Element {
  const { Icon, className } = POSTURE_ICON[state];
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} aria-hidden />
      {/* Pair the colour/icon with a text label for non-visual users. */}
      <span className="sr-only">{POSTURE_LABEL[state]}: </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
        {detail ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{detail}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

export interface PostureSummaryProps {
  readonly good: number;
  readonly recommended: number;
  readonly critical: number;
  readonly score?: number;
}

export function PostureSummary({ good, recommended, critical, score }: PostureSummaryProps): JSX.Element {
  const rows: ReadonlyArray<{ readonly state: PostureState; readonly value: number }> = [
    { state: "good", value: good },
    { state: "recommended", value: recommended },
    { state: "critical", value: critical },
  ];
  return (
    <dl className="space-y-1.5 text-sm">
      {score !== undefined ? (
        <div className="flex items-center gap-2 border-b border-zinc-200 pb-1.5 dark:border-zinc-800">
          <dt className="text-zinc-600 dark:text-zinc-400">Score</dt>
          <dd className="ml-auto text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{score}</dd>
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.state} className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", POSTURE_DOT[row.state])} aria-hidden />
          <dt className="text-zinc-600 dark:text-zinc-400">{POSTURE_LABEL[row.state]}</dt>
          <dd className={cn("ml-auto font-medium tabular-nums", POSTURE_VALUE_TEXT[row.state])}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
