"use client";

import { FlaskConical, Info } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A small, unmistakable "this is fake data" pill. Placed on every demo widget so
 * a viewer can never mistake an illustrative mock for real fleet state.
 */
export function DummyBadge({ label = "Dummy data", className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex select-none items-center gap-1 rounded-full border border-dashed border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <FlaskConical className="h-2.5 w-2.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * Full-width banner shown at the top of any mostly-mock demo surface. States
 * plainly that the figures below are illustrative and not real.
 */
export function DemoBanner({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-dashed border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200",
        className,
      )}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0">
        <span className="font-semibold">Demo dashboard.</span> The sites, charts and figures below are illustrative
        <span className="font-semibold"> dummy data</span> — they do not reflect real uptime, security, backups or
        traffic. Provisioning, the InfraWeaver Connector and access controls remain fully live.
      </p>
    </div>
  );
}
