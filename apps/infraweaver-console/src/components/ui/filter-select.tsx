"use client";
import { cn } from "@/lib/utils";

export interface FilterSelectOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Options as `{ value, label }` pairs or plain strings (used for both). */
  options: readonly (FilterSelectOption | string)[];
  /** Accessible name for the select (rendered as aria-label). */
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * The standard toolbar filter dropdown — shared copy of the identically
 * styled `<select>` filters repeated across list pages.
 */
export function FilterSelect({ value, onChange, options, label, id, disabled = false, className }: FilterSelectProps) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={cn(
        "h-11 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {options.map((option) => {
        const normalized = typeof option === "string" ? { value: option, label: option } : option;
        return (
          <option key={normalized.value} value={normalized.value}>
            {normalized.label}
          </option>
        );
      })}
    </select>
  );
}
