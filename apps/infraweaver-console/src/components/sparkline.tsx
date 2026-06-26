"use client";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  color?: string;
  height?: number;
  className?: string;
  showTooltip?: boolean;
  label?: string;
}

function buildAriaLabel(data: number[], label?: string): string {
  const prefix = label ? `${label}: ` : "Sparkline: ";
  if (data.length === 0) return `${prefix}no data`;
  const latest = data[data.length - 1];
  if (data.length === 1) return `${prefix}${latest}`;
  const first = data[0];
  const direction = latest > first ? "rising" : latest < first ? "falling" : "flat";
  return `${prefix}${direction}, latest ${latest}`;
}

export function Sparkline({
  data,
  color = "#6366f1",
  height = 40,
  className,
  showTooltip = false,
  label,
}: SparklineProps) {
  const chartData = data.map((value, index) => ({ index, value }));

  return (
    <div
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label={buildAriaLabel(data, label)}
    >
      <ResponsiveContainer width="100%" height="100%" aria-hidden>
        <LineChart data={chartData} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: color }}
          />
          {showTooltip && (
            <Tooltip
              contentStyle={{
                background: "rgba(15,23,42,0.9)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "8px",
                fontSize: "11px",
                color: "#cbd5e1",
              }}
              itemStyle={{ color: "#cbd5e1" }}
              formatter={(v) => [Number(v), "Value"] as [number, string]}
              labelFormatter={() => ""}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
