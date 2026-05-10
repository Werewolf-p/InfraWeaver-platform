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
  className?: string;
}

export function AutoRefreshControl({ interval, onChange, onRefreshNow, className }: AutoRefreshControlProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {onRefreshNow && (
        <button
          onClick={onRefreshNow}
          className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-white/10 transition-colors"
          aria-label="Refresh now"
          title="Refresh now"
        >
          <RefreshCw className="w-3.5 h-3.5 text-white/60" />
        </button>
      )}
      <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/5 border border-white/10">
        {intervalOptions.map(opt => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all",
              interval === opt.value
                ? "bg-white/15 text-white"
                : "text-white/40 hover:text-white/70"
            )}
          >
            {opt.value === 0 ? <Pause className="w-2.5 h-2.5" /> : null}
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
