"use client";
import { cn } from "@/lib/utils";

interface ProgressBarProps {
  value: number; // 0-100
  label?: string;
  showPercent?: boolean;
  size?: "sm" | "md" | "lg";
  color?: "indigo" | "green" | "yellow" | "red" | "blue";
  className?: string;
  animated?: boolean;
}

const colorMap = {
  indigo: "bg-indigo-500",
  green:  "bg-green-500",
  yellow: "bg-yellow-500",
  red:    "bg-red-500",
  blue:   "bg-blue-500",
};

const sizeMap = {
  sm: "h-1",
  md: "h-2",
  lg: "h-3",
};

export function ProgressBar({
  value,
  label,
  showPercent = true,
  size = "md",
  color = "indigo",
  className,
  animated = true,
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("w-full", className)}>
      {(label || showPercent) && (
        <div className="flex items-center justify-between mb-1.5">
          {label && <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>}
          {showPercent && <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">{clamped}%</span>}
        </div>
      )}
      <div className={cn("w-full bg-gray-100 dark:bg-white/5 rounded-full overflow-hidden", sizeMap[size])}>
        <div
          className={cn(
            "h-full rounded-full transition-all duration-700 ease-out relative overflow-hidden",
            colorMap[color]
          )}
          style={{ width: `${clamped}%` }}
        >
          {animated && (
            <div
              className="absolute inset-0 opacity-40"
              style={{
                background: "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)",
                backgroundSize: "200% 100%",
                animation: "shimmer 1.5s infinite",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
