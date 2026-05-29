"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function RefreshCountdown({
  intervalSeconds,
  resetKey,
  isFetching = false,
  className,
}: {
  intervalSeconds: number;
  resetKey?: string | number;
  isFetching?: boolean;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(intervalSeconds);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRemaining(intervalSeconds));
    return () => window.cancelAnimationFrame(frame);
  }, [intervalSeconds, resetKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining((prev) => (prev <= 1 ? intervalSeconds : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [intervalSeconds]);

  const progress = intervalSeconds > 0 ? ((intervalSeconds - remaining) / intervalSeconds) * 100 : 0;
  const imminent = remaining <= Math.max(5, Math.round(intervalSeconds * 0.2));
  const spin = isFetching || imminent;

  return (
    <div
      role="status"
      aria-live="polite"
      title={isFetching ? "Refreshing now" : `Next refresh in ${remaining} seconds`}
      className={cn("inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/90 px-2.5 py-1.5 text-xs text-slate-500 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-400", className)}
    >
      <RefreshCw className={cn("h-3.5 w-3.5", spin && "animate-spin text-sky-500 dark:text-sky-300")} aria-hidden="true" />
      <span className="font-medium text-slate-700 dark:text-slate-200">{isFetching ? "Refreshing…" : `Refresh in ${remaining}s`}</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-100 dark:bg-white/10" aria-hidden="true">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-500", spin ? "bg-sky-500 dark:bg-sky-300" : "bg-slate-400 dark:bg-slate-500")}
          style={{ width: isFetching ? "100%" : `${Math.max(progress, 6)}%` }}
        />
      </span>
    </div>
  );
}
