"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ShieldHalf } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type AllowedRuleEntry,
  type BlockedDestination,
  type Direction,
  type PodDenies,
  type RulesResponse,
  flowId,
  podFlowCount,
} from "../types";
import { DenyRow } from "./deny-row";
import { Exceptions } from "./exceptions";
import { EASE_OUT } from "./motion";

interface PodCellProps {
  pod: PodDenies;
  bidirectional: boolean;
  rules: RulesResponse | null;
  onExpand: (pod: PodDenies) => void;
  onAllow: (pod: PodDenies, direction: Direction, peer: BlockedDestination, bidirectional: boolean) => Promise<{ ok: boolean }>;
  onCommit: (id: string) => void;
  onRemove: (pod: PodDenies, rule: AllowedRuleEntry) => Promise<{ ok: boolean }>;
}

function DirectionGroup({
  label,
  icon: Icon,
  pod,
  direction,
  items,
  bidirectional,
  onAllow,
  onCommit,
}: {
  label: string;
  icon: typeof ArrowDownLeft;
  pod: PodDenies;
  direction: Direction;
  items: BlockedDestination[];
  bidirectional: boolean;
  onAllow: PodCellProps["onAllow"];
  onCommit: PodCellProps["onCommit"];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="flex items-center gap-1.5 px-4 pt-2.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-[#777]">
        <Icon className="h-3.5 w-3.5 text-[var(--az-danger)]" aria-hidden />
        {label}
      </div>
      <ul>
        <AnimatePresence initial={false}>
          {items.map((peer) => (
            <DenyRow
              key={flowId(pod, direction, peer)}
              pod={pod}
              direction={direction}
              peer={peer}
              bidirectional={bidirectional}
              onAllow={onAllow}
              onCommit={onCommit}
            />
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function PodCell({ pod, bidirectional, rules, onExpand, onAllow, onCommit, onRemove }: PodCellProps) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const count = podFlowCount(pod);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !rules) onExpand(pod);
  }

  return (
    <motion.section
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.32, ease: EASE_OUT }}
      className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#141414]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 dark:border-[#1e1e1e] dark:bg-[#0f0f0f]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
            {!reduce && (
              <motion.span
                className="absolute inline-flex h-full w-full rounded-full bg-[var(--az-danger)]"
                animate={{ opacity: [0.7, 0, 0.7], scale: [1, 2.2, 1] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeOut" }}
              />
            )}
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--az-danger)]" />
          </span>
          <div className="min-w-0 truncate">
            <span className="font-mono text-xs text-slate-400 dark:text-[#777]">{pod.namespace}/</span>
            <span className="font-medium text-slate-800 dark:text-[#ededed]">{pod.pod}</span>
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          {count} blocked
        </span>
      </header>

      <DirectionGroup
        label="Inbound blocked"
        icon={ArrowDownLeft}
        pod={pod}
        direction="ingress"
        items={pod.ingress}
        bidirectional={bidirectional}
        onAllow={onAllow}
        onCommit={onCommit}
      />
      <DirectionGroup
        label="Outbound blocked"
        icon={ArrowUpRight}
        pod={pod}
        direction="egress"
        items={pod.egress}
        bidirectional={bidirectional}
        onAllow={onAllow}
        onCommit={onCommit}
      />

      <div className="border-t border-slate-100 dark:border-[#1e1e1e]">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 dark:text-[#999] dark:hover:bg-[#1a1a1a]"
        >
          <ShieldHalf className="h-3.5 w-3.5 text-[var(--az-primary)]" aria-hidden />
          Active exceptions
          <ChevronDown
            className={cn("ml-auto h-3.5 w-3.5 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="exceptions"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.26, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <Exceptions pod={pod} rules={rules} onRemove={onRemove} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
