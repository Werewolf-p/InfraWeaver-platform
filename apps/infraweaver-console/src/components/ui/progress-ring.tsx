"use client";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface ProgressRingProps {
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: "emerald" | "amber" | "red" | "blue" | "auto";
  label?: string;
  showValue?: boolean;
  animated?: boolean;
  className?: string;
}

const COLOR_MAP = {
  emerald: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  blue: "#3b82f6",
};

function getAutoColor(value: number): string {
  if (value >= 80) return COLOR_MAP.red;
  if (value >= 60) return COLOR_MAP.amber;
  return COLOR_MAP.emerald;
}

export function ProgressRing({
  value,
  size = 80,
  strokeWidth = 8,
  color = "auto",
  label,
  showValue = true,
  animated = true,
  className,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  const strokeColor = color === "auto" ? getAutoColor(value) : COLOR_MAP[color];

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={strokeWidth}
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={animated ? { strokeDashoffset: circumference } : { strokeDashoffset: offset }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1, ease: "easeOut", delay: 0.2 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {showValue && (
          <span className="text-xs font-bold text-gray-900 dark:text-white tabular-nums">
            {Math.round(value)}%
          </span>
        )}
        {label && <span className="text-[9px] text-slate-500 dark:text-slate-400 mt-0.5">{label}</span>}
      </div>
    </div>
  );
}
