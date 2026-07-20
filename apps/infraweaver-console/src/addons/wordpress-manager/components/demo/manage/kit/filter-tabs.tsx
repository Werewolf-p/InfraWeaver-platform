"use client";

/**
 * Segmented single-select control (a "pick one filter" rail). Rendered as a
 * `role="group"` of `aria-pressed` toggle buttons with arrow/Home/End keyboard
 * navigation, `focus-visible` rings and ≥24px hit targets. Each option may carry a
 * count badge (figure-aligned). The active option carries both a filled background
 * AND stronger text so selection never rides on colour alone.
 */

import { useRef, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface FilterTabOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly count?: number;
}

export interface FilterTabsProps<T extends string> {
  readonly options: readonly FilterTabOption<T>[];
  readonly value: T;
  readonly onChange: (v: T) => void;
  readonly ariaLabel: string;
  readonly className?: string;
}

export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: FilterTabsProps<T>): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void {
    const { key } = event;
    if (key !== "ArrowRight" && key !== "ArrowLeft" && key !== "Home" && key !== "End") return;
    event.preventDefault();
    const last = options.length - 1;
    let next = index;
    if (key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (key === "Home") next = 0;
    else next = last;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex flex-wrap items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-950/40",
        className,
      )}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex min-h-[24px] items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50",
              active
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
            )}
          >
            <span>{option.label}</span>
            {option.count !== undefined ? (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                  active
                    ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200"
                    : "bg-zinc-200/70 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
