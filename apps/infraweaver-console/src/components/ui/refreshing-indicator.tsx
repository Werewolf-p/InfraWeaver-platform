"use client";

import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { springs } from "@/lib/spring";

interface RefreshingIndicatorProps {
  /** Whether a background refetch is currently in flight (e.g. react-query isFetching). */
  active: boolean;
  /** Optional label shown next to the spinner. Defaults to "Refreshing". */
  label?: string;
  className?: string;
}

/**
 * Subtle, non-jarring "refreshing" affordance for use alongside data that stays
 * on screen during a background refetch (react-query keepPreviousData). Mounts
 * only while a refetch is in flight and announces politely to assistive tech.
 */
export function RefreshingIndicator({ active, label = "Refreshing", className }: RefreshingIndicatorProps) {
  return (
    <AnimatePresence>
      {active ? (
        <motion.span
          key="refreshing"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={springs.snappy}
          role="status"
          aria-live="polite"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-600 dark:text-sky-300",
            className,
          )}
        >
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          <span>{label}</span>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
