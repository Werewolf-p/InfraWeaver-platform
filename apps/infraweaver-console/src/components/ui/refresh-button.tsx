"use client";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface RefreshButtonProps {
  onClick: () => void;
  /** Spins the icon while a refetch is in flight (pass `isFetching`). */
  refreshing?: boolean;
  disabled?: boolean;
  /** Button text. Default "Refresh". */
  label?: string;
  className?: string;
}

/**
 * The standard page-header refresh action — shared copy of the identical
 * `<RefreshCw> Refresh` buttons repeated across dashboard pages.
 */
export function RefreshButton({ onClick, refreshing = false, disabled = false, label = "Refresh", className }: RefreshButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <RefreshCw aria-hidden="true" className={cn("h-4 w-4", refreshing && "animate-spin")} />
      {label}
    </button>
  );
}
