"use client";
import { RefreshCw, Pause } from "lucide-react";
import { cn } from "@/lib/utils";

const intervalOptions = [
  { label: "Off", value: 0 },
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
  { label: "5m", value: 300000 },
];

interface AutoRefreshControlProps {
  interval: number;
  onChange: (interval: number) => void;
  onRefreshNow?: () => void;
  /** When true, the manual refresh icon spins to show a refetch is in flight. */
  isFetching?: boolean;
  className?: string;
}

export function AutoRefreshControl({ interval, onChange, onRefreshNow, isFetching = false, className }: AutoRefreshControlProps) {
  return (
    <div className={cn("flex items-center gap-2", className)} role="group" aria-label="Auto-refresh">
      {onRefreshNow && (
        <button
          onClick={onRefreshNow}
          className="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 transition-colors touch-manipulation"
          aria-label="Refresh now"
          title="Refresh now"
        >
          <RefreshCw className={cn("w-4 h-4 text-gray-500 dark:text-white/60", isFetching && "animate-spin text-sky-500 dark:text-sky-300")} aria-hidden="true" />
        </button>
      )}
      <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10">
        {intervalOptions.map(opt => {
          const selected = interval === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              aria-pressed={selected}
              title={opt.value === 0 ? "Auto-refresh off" : `Auto-refresh every ${opt.label}`}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all touch-manipulation",
                selected
                  ? "bg-white/15 text-gray-900 dark:text-white"
                  : "text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/70"
              )}
            >
              {opt.value === 0 ? <Pause className="w-2.5 h-2.5" aria-hidden="true" /> : null}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
