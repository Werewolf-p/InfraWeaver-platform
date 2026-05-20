"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

export interface SparklinePoint {
  label: string;
  value: number;
}

export type SparklineTone = "emerald" | "amber" | "red" | "blue" | "violet" | "slate";

interface MetricSparklineProps {
  data: SparklinePoint[];
  color?: SparklineTone;
  className?: string;
  height?: number;
  valueFormatter?: (value: number) => string;
  ariaLabel?: string;
}

const COLORS: Record<SparklineTone, { stroke: string; fill: string }> = {
  emerald: { stroke: "#10b981", fill: "#10b981" },
  amber: { stroke: "#f59e0b", fill: "#f59e0b" },
  red: { stroke: "#ef4444", fill: "#ef4444" },
  blue: { stroke: "#3b82f6", fill: "#3b82f6" },
  violet: { stroke: "#8b5cf6", fill: "#8b5cf6" },
  slate: { stroke: "#94a3b8", fill: "#94a3b8" },
};

export function MetricSparkline({
  data,
  color = "blue",
  className,
  height = 52,
  valueFormatter = (value) => `${Math.round(value)}`,
  ariaLabel,
}: MetricSparklineProps) {
  const palette = COLORS[color];
  const gradientId = useId().replace(/:/g, "");

  if (data.length === 0) {
    return null;
  }

  return (
    <div className={cn("h-12 w-full", className)} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 2, left: 2, bottom: 2 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={palette.fill} stopOpacity={0.28} />
              <stop offset="95%" stopColor={palette.fill} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip
            cursor={false}
            contentStyle={{
              background: "rgba(15, 23, 42, 0.94)",
              border: "1px solid rgba(148, 163, 184, 0.22)",
              borderRadius: "12px",
              color: "#e2e8f0",
              fontSize: "12px",
              padding: "8px 10px",
            }}
            formatter={(value: unknown) => [valueFormatter(Number(value ?? 0)), "Trend"]}
            labelFormatter={(label) => `${label}`}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={palette.stroke}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, fill: palette.stroke, stroke: "rgba(15,23,42,0.9)", strokeWidth: 2 }}
            isAnimationActive
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
