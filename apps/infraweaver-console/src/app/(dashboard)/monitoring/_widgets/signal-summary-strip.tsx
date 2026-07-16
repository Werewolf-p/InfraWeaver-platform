"use client";

import { Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SignalsSummary } from "@/lib/observability-signals";
import { SEVERITY_UI } from "./signal-card";

interface SignalSummaryStripProps {
  summary: SignalsSummary;
  isLoading?: boolean;
}

/**
 * Top-of-board triage strip: worst severity, critical/warn counts, and the
 * single "next thing to break" headline (the highest-severity signal).
 */
export function SignalSummaryStrip({ summary, isLoading }: SignalSummaryStripProps) {
  if (isLoading) {
    return <div className="h-24 animate-pulse rounded-2xl bg-gray-100 dark:bg-white/5" />;
  }

  const worstUi = SEVERITY_UI[summary.worst];
  const WorstIcon = worstUi.icon;
  const nextToBreak = summary.signals.find((signal) => signal.severity !== "ok");

  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between",
        summary.worst === "critical"
          ? "border-red-500/30 bg-red-500/5"
          : summary.worst === "warn"
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-emerald-500/30 bg-emerald-500/5",
      )}
    >
      <div className="flex items-center gap-3">
        <span className={cn("flex h-11 w-11 items-center justify-center rounded-xl", worstUi.chip)}>
          <WorstIcon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-[#888]">Next to break</p>
          <p className="truncate text-sm font-semibold text-gray-900 dark:text-white">
            {nextToBreak ? `${nextToBreak.label}: ${nextToBreak.headline}` : "Nothing is brewing — all signals healthy"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="text-center">
          <p className="text-2xl font-bold text-red-500">{summary.criticalCount}</p>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">Critical</p>
        </div>
        <div className="text-center">
          <p className="text-2xl font-bold text-amber-500">{summary.warnCount}</p>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">Watch</p>
        </div>
        <div className="text-center">
          <p className="flex items-center gap-1.5 text-2xl font-bold text-gray-900 dark:text-white">
            <Gauge className="h-5 w-5 opacity-70" aria-hidden="true" />
            {summary.signals.length}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">Signals</p>
        </div>
      </div>
    </div>
  );
}
