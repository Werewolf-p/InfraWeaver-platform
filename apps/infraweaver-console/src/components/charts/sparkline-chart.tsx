"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

const COLORS = {
  emerald: { stroke: "#10b981", fill: "#10b981" },
  amber: { stroke: "#f59e0b", fill: "#f59e0b" },
  red: { stroke: "#ef4444", fill: "#ef4444" },
  blue: { stroke: "#3b82f6", fill: "#3b82f6" },
  violet: { stroke: "#8b5cf6", fill: "#8b5cf6" },
  slate: { stroke: "#94a3b8", fill: "#94a3b8" },
} as const;

type SparklineTone = keyof typeof COLORS;

interface Props {
  data: Array<{ label: string; value: number }>;
  color: SparklineTone;
  height: number;
  valueFormatter: (value: number) => string;
}

export function SparklineChart({ data, color, height, valueFormatter }: Props) {
  const palette = COLORS[color];
  const gradientId = useId().replace(/:/g, "");

  return (
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
  );
}
