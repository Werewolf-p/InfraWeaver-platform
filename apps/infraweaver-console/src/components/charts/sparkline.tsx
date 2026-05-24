"use client";

import dynamic from "next/dynamic";
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

const SparklineChart = dynamic(
  () => import("./sparkline-chart").then((m) => m.SparklineChart),
  {
    ssr: false,
    loading: () => <div className="h-12 w-full animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />,
  },
);

export function MetricSparkline({
  data,
  color = "blue",
  className,
  height = 52,
  valueFormatter = (value) => `${Math.round(value)}`,
  ariaLabel,
}: MetricSparklineProps) {
  if (data.length === 0) return null;

  return (
    <div className={cn("h-12 w-full", className)} role="img" aria-label={ariaLabel}>
      <SparklineChart data={data} color={color} height={height} valueFormatter={valueFormatter} />
    </div>
  );
}
