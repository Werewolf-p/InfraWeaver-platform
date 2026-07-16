"use client";

import Link from "next/link";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { Signal } from "@/lib/observability-signals";
import { SEVERITY_UI } from "./signal-card";

interface BrewingIncidentsFeedProps {
  signals: Signal[];
}

/**
 * The single actionable list — every non-ok signal, severity-sorted, each row a
 * headline + why + deep-link to the owning page. This is the anti-outage payoff.
 */
export function BrewingIncidentsFeed({ signals }: BrewingIncidentsFeedProps) {
  const incidents = signals.filter((signal) => signal.severity !== "ok");

  if (incidents.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nothing is brewing"
        description="Every observability signal is healthy. New pre-outage traps will surface here, sorted worst-first."
        className="py-10"
      />
    );
  }

  return (
    <div className="space-y-2">
      {incidents.map((signal) => {
        const ui = SEVERITY_UI[signal.severity];
        return (
          <Link
            key={signal.id}
            href={signal.href}
            className={cn(
              "group flex items-start justify-between gap-3 rounded-xl border p-3 transition-colors",
              signal.severity === "critical"
                ? "border-red-500/30 bg-red-500/5 hover:bg-red-500/10"
                : "border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10",
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", ui.dot)} aria-hidden="true" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  {signal.label}
                  <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", ui.chip)}>
                    {ui.label}
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-gray-700 dark:text-[#d4d4d4]">{signal.headline}</p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-[#888]">{signal.detail}</p>
              </div>
            </div>
            <ArrowUpRight className="mt-1 h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-cyan-400" aria-hidden="true" />
          </Link>
        );
      })}
    </div>
  );
}
