import { TrendingDown, TrendingUp } from "lucide-react";
import { MetricSparkline, type SparklinePoint } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

interface DataCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  trend?: "up" | "down";
  trendData?: SparklinePoint[];
  className?: string;
}

export function DataCard({ title, value, subtitle, trend, trendData, className }: DataCardProps) {
  return (
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-[#2a2a2a] dark:bg-[#111]", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-[#888]">{title}</p>
        {trend === "up" ? (
          <TrendingUp className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
        ) : trend === "down" ? (
          <TrendingDown className="h-4 w-4 text-rose-500 dark:text-red-400" />
        ) : null}
      </div>
      <p className="mt-3 text-2xl font-semibold text-slate-950 dark:text-[#f2f2f2]">{value}</p>
      {trendData && trendData.length > 1 ? <MetricSparkline data={trendData} color={trend === "down" ? "red" : "emerald"} height={40} className="mt-3 h-10" /> : null}
      {subtitle ? <p className="mt-2 text-sm text-slate-500 dark:text-[#888]">{subtitle}</p> : null}
    </div>
  );
}
