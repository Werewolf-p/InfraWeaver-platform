import type { ElementType, ReactNode } from "react";
import { MetricSparkline, type SparklinePoint, type SparklineTone } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

interface DashboardStatCardProps {
  label: string;
  value: string | number;
  icon?: ElementType;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  description?: string;
  footer?: ReactNode;
  trendData?: SparklinePoint[];
  trendTone?: SparklineTone;
  trendLabel?: string;
  className?: string;
}

const toneStyles: Record<NonNullable<DashboardStatCardProps["tone"]>, string> = {
  neutral: "border-slate-200 bg-white text-slate-950 shadow-sm dark:border-[#2a2a2a] dark:bg-[#141414] dark:text-[#f2f2f2]",
  info: "border-sky-200 bg-sky-50/90 text-slate-950 shadow-sm dark:border-[#0078D4]/20 dark:bg-[rgba(0,120,212,0.08)] dark:text-[#f2f2f2]",
  success: "border-emerald-200 bg-emerald-50/90 text-slate-950 shadow-sm dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-[#f2f2f2]",
  warning: "border-amber-200 bg-amber-50/90 text-slate-950 shadow-sm dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-[#f2f2f2]",
  danger: "border-rose-200 bg-rose-50/90 text-slate-950 shadow-sm dark:border-red-500/20 dark:bg-red-500/10 dark:text-[#f2f2f2]",
};

export function DashboardStatCard({
  label,
  value,
  icon: Icon,
  tone = "neutral",
  description,
  footer,
  trendData,
  trendTone = tone === "danger" ? "red" : tone === "warning" ? "amber" : tone === "success" ? "emerald" : "blue",
  trendLabel,
  className,
}: DashboardStatCardProps) {
  const hasTrend = Boolean(trendData && trendData.length > 1);

  return (
    <div className={cn("rounded-2xl border p-4 md:p-5", toneStyles[tone], className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 dark:text-[#888]">{label}</p>
          <p className="mt-3 text-2xl font-semibold text-current md:text-[1.9rem]">{value}</p>
        </div>
        {Icon ? <Icon className="mt-0.5 h-5 w-5 shrink-0 text-current opacity-80" /> : null}
      </div>
      {hasTrend ? (
        <div className="mt-3 rounded-xl border border-black/5 bg-white/70 px-2 py-1.5 dark:border-white/5 dark:bg-white/[0.03]">
          <MetricSparkline
            data={trendData ?? []}
            color={trendTone}
            height={44}
            className="h-11"
            ariaLabel={trendLabel ?? `${label} trend`}
          />
        </div>
      ) : null}
      {description ? <p className="mt-3 text-sm text-slate-600 dark:text-[#b8b8b8]">{description}</p> : null}
      {footer ? <div className="mt-3 text-xs text-slate-500 dark:text-[#888]">{footer}</div> : null}
    </div>
  );
}
