"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, CheckCircle2, AlertTriangle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { SIGNAL_HREF, SOURCE_LABEL, type Severity, type Signal, type SignalSource } from "@/lib/observability-signals";

/** Shared severity styling for every board widget + the summary strip. */
export const SEVERITY_UI: Record<Severity, { label: string; chip: string; dot: string; icon: typeof CheckCircle2 }> = {
  ok: {
    label: "Healthy",
    chip: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    dot: "bg-emerald-500",
    icon: CheckCircle2,
  },
  warn: {
    label: "Watch",
    chip: "text-amber-500 bg-amber-500/10 border-amber-500/20",
    dot: "bg-amber-500",
    icon: AlertTriangle,
  },
  critical: {
    label: "Critical",
    chip: "text-red-500 bg-red-500/10 border-red-500/20",
    dot: "bg-red-500",
    icon: ShieldAlert,
  },
};

export function SeverityChip({ severity, className }: { severity: Severity; className?: string }) {
  const ui = SEVERITY_UI[severity];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", ui.chip, className)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", ui.dot)} aria-hidden="true" />
      {ui.label}
    </span>
  );
}

interface SignalCardProps {
  /** Domain source — supplies label + deep-link even before the signal resolves. */
  source: SignalSource;
  /** Resolved signal; absent while the underlying query loads/errors. */
  signal?: Signal;
  /** Loading state renders a skeleton instead of the body. */
  isLoading?: boolean;
  /** Error state renders a muted "unavailable" line. */
  isError?: boolean;
  children?: ReactNode;
}

/**
 * Shared widget shell: severity chip + headline + deep-link, with widget-specific
 * body as children. Every board widget wraps its content in this so the chip,
 * link, and loading/error states never drift across widgets. Label and href fall
 * back to the source maps so the card renders before data arrives.
 */
export function SignalCard({ source, signal, isLoading, isError, children }: SignalCardProps) {
  const label = signal?.label ?? SOURCE_LABEL[source];
  const href = signal?.href ?? SIGNAL_HREF[source];

  return (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{label}</h3>
          {!isLoading && !isError && signal ? (
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-[#9e9e9e]">{signal.headline}</p>
          ) : null}
        </div>
        {!isLoading && signal ? <SeverityChip severity={isError ? "warn" : signal.severity} /> : null}
      </div>

      {isLoading ? (
        <div className="mt-4 h-20 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />
      ) : isError || !signal ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-[#888]">Signal data is unavailable right now.</p>
      ) : (
        <div className="mt-3 flex-1">{children}</div>
      )}

      <Link href={href} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400">
        Investigate
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
