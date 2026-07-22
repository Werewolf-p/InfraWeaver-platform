"use client";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";

interface DataPoint {
  time: string;
  value: number;
}

interface MetricAreaChartProps {
  data: DataPoint[];
  label: string;
  unit?: string;
  color?: "emerald" | "amber" | "red" | "indigo";
  warnAt?: number;
  critAt?: number;
  className?: string;
}

const COLORS = {
  emerald: { stroke: "#10b981", fill: "#10b981" },
  amber: { stroke: "#f59e0b", fill: "#f59e0b" },
  red: { stroke: "#ef4444", fill: "#ef4444" },
  indigo: { stroke: "#6366f1", fill: "#6366f1" },
};

function buildAriaLabel(label: string, data: DataPoint[], unit: string, warnAt: number, critAt: number): string {
  const lastVal = data[data.length - 1]?.value ?? 0;
  const status = lastVal >= critAt ? "critical" : lastVal >= warnAt ? "warning" : "normal";
  const current = `${label}: currently ${Math.round(lastVal)}${unit}, status ${status}`;
  if (data.length < 2) {
    return current;
  }
  const values = data.map((d) => d.value);
  const min = Math.round(Math.min(...values));
  const max = Math.round(Math.max(...values));
  return `${current}, range ${min}${unit}–${max}${unit} across ${data.length} data points`;
}

export function MetricAreaChart({ data, label, unit = "%", color = "emerald", warnAt = 70, critAt = 90, className }: MetricAreaChartProps) {
  const lastVal = data[data.length - 1]?.value ?? 0;
  const activeColor = lastVal >= critAt ? "red" : lastVal >= warnAt ? "amber" : color;
  const { stroke, fill } = COLORS[activeColor];
  const gradId = `grad-${label.replace(/\s+/g, "")}`;
  const ariaLabel = buildAriaLabel(label, data, unit, warnAt, critAt);

  return (
    <div role="img" aria-label={ariaLabel} className={cn("rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-3 sm:p-4", className)}>
      <div className="mb-2 flex items-center justify-between sm:mb-3">
        <span className="text-xs font-medium text-slate-700 dark:text-slate-300 sm:text-sm">{label}</span>
        <span className={cn("text-base font-bold tabular-nums sm:text-lg", lastVal >= critAt ? "text-red-400" : lastVal >= warnAt ? "text-amber-400" : "text-emerald-400")}>
          {Math.round(lastVal)}{unit}
        </span>
      </div>
      <div aria-hidden="true" className="h-[200px] w-full sm:h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={fill} stopOpacity={0.3} />
              <stop offset="95%" stopColor={fill} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--color-border))" />
          <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ background: "rgb(var(--color-surface-raised))", border: "1px solid rgb(var(--color-border))", borderRadius: "8px", fontSize: "12px", color: "rgb(var(--color-text-primary))" }}
            formatter={(v: unknown) => [`${Math.round(v as number)}${unit}`, label]}
            labelFormatter={(l) => `Time: ${l}`}
          />
          <Area type="monotone" dataKey="value" stroke={stroke} strokeWidth={2} fill={`url(#${gradId})`} dot={false} isAnimationActive />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
