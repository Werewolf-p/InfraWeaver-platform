"use client";

/**
 * Small rounded-full status badge. Colour is always paired WITH text (and an
 * optional leading icon) so the meaning never rides on colour alone — one tone →
 * one border/background/text class triple. Matches the console's zinc/sky idiom,
 * light + dark.
 */

import type { ElementType, JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PillTone = "good" | "warn" | "critical" | "info" | "neutral";

const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};

export interface PillProps {
  readonly tone: PillTone;
  readonly children: ReactNode;
  readonly icon?: ElementType;
  readonly className?: string;
}

export function Pill({ tone, children, icon: Icon, className }: PillProps): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        PILL_TONE[tone],
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}
