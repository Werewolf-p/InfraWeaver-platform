"use client";

import type { ComponentType } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

const MetricCardSparkline = dynamic(
  () => import("./metric-card-sparkline").then((m) => m.MetricCardSparkline),
  { ssr: false },
);

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  trend?: { direction: "up" | "down" | "flat"; percent: number };
  sparklineData?: Array<{ value: number }>;
  href?: string;
  variant?: "default" | "success" | "warning" | "danger";
  loading?: boolean;
  className?: string;
  index?: number;
  icon?: ComponentType<{ className?: string }>;
  status?: "healthy" | "degraded" | "warning" | "neutral";
}

const VARIANT_STYLES = {
  default: {
    accent: "text-[rgb(var(--color-info))]",
    badge: "bg-[rgb(var(--color-brand-500))]/10 text-[rgb(var(--color-brand-600))] dark:text-[rgb(var(--color-brand-500))]",
    line: "#3b82f6",
  },
  success: {
    accent: "text-[rgb(var(--color-success))]",
    badge: "bg-[rgb(var(--color-success))]/10 text-[rgb(var(--color-success))]",
    line: "#10b981",
  },
  warning: {
    accent: "text-[rgb(var(--color-warning))]",
    badge: "bg-[rgb(var(--color-warning))]/10 text-[rgb(var(--color-warning))]",
    line: "#f59e0b",
  },
  danger: {
    accent: "text-[rgb(var(--color-danger))]",
    badge: "bg-[rgb(var(--color-danger))]/10 text-[rgb(var(--color-danger))]",
    line: "#ef4444",
  },
} as const;

function TrendIcon({ direction }: { direction: NonNullable<MetricCardProps["trend"]>["direction"] }) {
  if (direction === "up") return <TrendingUp className="h-3.5 w-3.5" />;
  if (direction === "down") return <TrendingDown className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
}

export function MetricCard({
  title,
  value,
  unit,
  trend,
  sparklineData,
  href,
  variant = "default",
  loading,
  className,
  index,
}: MetricCardProps) {
  const styles = VARIANT_STYLES[variant];
  const card = (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 24, mass: 1, delay: (index ?? 0) * 0.06 }}
      whileHover={{ y: -2, boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
      className={cn(
        "group flex h-full flex-col justify-between rounded-2xl border border-[rgb(var(--color-border))] bg-[rgb(var(--color-surface-base))] p-5 shadow-sm transition-all duration-200",
        href && "cursor-pointer hover:-translate-y-0.5 hover:border-[rgb(var(--color-border-strong))] hover:shadow-md",
        className,
      )}
    >
      {loading ? (
        <div className="space-y-4">
          <div className="h-4 w-28 rounded-md shimmer-bg" />
          <div className="h-8 w-32 rounded-md shimmer-bg" />
          <div className="h-12 w-full rounded-xl shimmer-bg" />
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[rgb(var(--color-text-secondary))]">{title}</p>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <span className="text-3xl font-semibold tracking-tight text-[rgb(var(--color-text-primary))]">{value}</span>
                {unit ? <span className="pb-1 text-sm text-[rgb(var(--color-text-secondary))]">{unit}</span> : null}
              </div>
            </div>
            {trend ? (
              <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", styles.badge)}>
                <TrendIcon direction={trend.direction} />
                {trend.percent}%
              </span>
            ) : null}
          </div>
          <div className="mt-5 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs text-[rgb(var(--color-text-tertiary))]">
                {trend
                  ? trend.direction === "flat"
                    ? "Stable against baseline"
                    : trend.direction === "up"
                      ? "Improving trend"
                      : "Requires attention"
                  : "Live infrastructure metric"}
              </p>
            </div>
            <div className="h-12 w-28 shrink-0">
              {sparklineData && sparklineData.length > 1 ? (
                <MetricCardSparkline data={sparklineData} color={styles.line} />
              ) : (
                <div className="flex h-full items-end">
                  <div className="h-8 w-full rounded-xl bg-[rgb(var(--color-surface-raised))]" />
                </div>
              )}
            </div>
          </div>
          {href ? <span className={cn("mt-4 text-xs font-medium", styles.accent)}>Open details</span> : null}
        </>
      )}
    </motion.div>
  );

  return href ? <Link href={href}>{card}</Link> : card;
}
