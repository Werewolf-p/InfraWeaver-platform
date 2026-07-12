"use client";
import { cn } from "@/lib/utils";

export interface PillTab<T extends string = string> {
  value: T;
  label: string;
  /** Optional count badge rendered after the label. */
  count?: number;
}

interface PillTabsProps<T extends string = string> {
  tabs: readonly PillTab<T>[];
  active: T;
  onChange: (value: T) => void;
  /** Accessible name for the tab group. */
  label?: string;
  className?: string;
}

/**
 * Rounded pill filter tabs — shared copy of the identical pill-button rows
 * (active: accent border/fill, inactive: subtle border) repeated across pages.
 */
export function PillTabs<T extends string = string>({ tabs, active, onChange, label, className }: PillTabsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-2", className)}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          aria-pressed={active === tab.value}
          className={cn(
            "min-h-[40px] rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            active === tab.value
              ? "border-[#0078D4]/40 bg-[#0078D4]/10 text-[#7cb9ff]"
              : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
          )}
        >
          {tab.label}
          {typeof tab.count === "number" ? <span className="ml-1 opacity-70">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
