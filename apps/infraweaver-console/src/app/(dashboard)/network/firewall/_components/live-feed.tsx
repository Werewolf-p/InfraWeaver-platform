"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Radio, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { type FeedEntry } from "../types";
import { EASE_OUT } from "./motion";

interface LiveFeedProps {
  feed: FeedEntry[];
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

/**
 * A live ticker of denials as they are first observed. Honest by construction:
 * an entry appears the poll a flow is first seen being dropped, never a replay
 * of history. Empty until something is actually blocked.
 */
export function LiveFeed({ feed }: LiveFeedProps) {
  const reduce = useReducedMotion();
  if (feed.length === 0) return null;

  return (
    <section
      aria-label="Live denials"
      className="rounded-2xl border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#141414]"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-[#1e1e1e]">
        <Radio className="h-3.5 w-3.5 text-[var(--az-danger)]" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide text-slate-600 dark:text-[#bbb]">
          Live denials
        </span>
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--az-danger)]" aria-hidden />
      </div>
      <ul role="log" aria-live="off" className="custom-scrollbar max-h-44 divide-y divide-slate-100 overflow-y-auto dark:divide-[#1a1a1a]">
        <AnimatePresence initial={false}>
          {feed.map((e) => {
            const Dir = e.direction === "ingress" ? ArrowDownLeft : ArrowUpRight;
            return (
              <motion.li
                key={e.id + e.ts}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
                className="flex items-center gap-3 px-4 py-2 text-[13px]"
              >
                <Dir className="h-3.5 w-3.5 shrink-0 text-[var(--az-danger)]" aria-hidden />
                <span className="shrink-0 font-mono text-xs text-slate-400 dark:text-[#777]">{e.namespace}</span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-slate-700 dark:text-[#ddd]">{e.pod}</span>
                  <span className="text-slate-400 dark:text-[#777]"> {e.direction === "ingress" ? "←" : "→"} </span>
                  <span className="font-mono text-slate-600 dark:text-[#bbb]">{e.target}</span>
                  {e.port ? <span className="text-slate-400 dark:text-[#777]">:{e.port}</span> : null}
                </span>
                <span className="shrink-0 tabular text-xs text-slate-400 dark:text-[#777]">{ago(e.ts)} ago</span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </section>
  );
}
