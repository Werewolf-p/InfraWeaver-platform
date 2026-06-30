"use client";

import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Loader2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { type AllowedRuleEntry, type PodDenies, type RulesResponse } from "../types";
import { EASE_OUT } from "./motion";

interface ExceptionsProps {
  pod: PodDenies;
  rules: RulesResponse | null;
  onRemove: (pod: PodDenies, rule: AllowedRuleEntry) => Promise<{ ok: boolean }>;
}

function ruleKey(r: AllowedRuleEntry): string {
  return `${r.policyName}|${r.direction}|${r.index}`;
}

function ExceptionRow({ rule, onRemove }: { rule: AllowedRuleEntry; onRemove: () => Promise<{ ok: boolean }> }) {
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState(false);

  async function handle() {
    if (busy) return;
    setBusy(true);
    const { ok } = await onRemove();
    if (!ok) setBusy(false); // on success the row is removed by the parent reload
  }

  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -20 }}
      transition={{ duration: 0.24, ease: EASE_OUT }}
      className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            rule.direction === "ingress" ? "bg-sky-400" : "bg-[var(--az-primary)]",
          )}
          aria-hidden
        />
        <span className="truncate font-mono text-slate-700 dark:text-[#ddd]">{rule.peer}</span>
        <span className="shrink-0 text-xs text-slate-400 dark:text-[#777]">· {rule.ports}</span>
        {rule.managed ? (
          <span className="shrink-0 rounded bg-[var(--az-primary-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--az-primary)]">
            console
          </span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={handle}
        disabled={busy}
        aria-label={`Remove ${rule.direction} exception ${rule.peer} and re-seal`}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rose-300/70 bg-rose-50 px-2.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Undo2 className="h-3.5 w-3.5" aria-hidden />}
        {busy ? "Sealing…" : "Re-seal"}
      </button>
    </motion.li>
  );
}

/** The deliberate openings in a pod's airgap. Removing one re-seals that path. */
export function Exceptions({ pod, rules, onRemove }: ExceptionsProps) {
  if (!rules) {
    return <p className="px-3 py-2 text-xs text-slate-400 dark:text-[#777]">Reading active exceptions…</p>;
  }
  // The pod-rules API can return { available:false } with no arrays (sealed pod /
  // dataplane not reporting) — guard so we never spread null/undefined.
  const all = [...(rules.ingress ?? []), ...(rules.egress ?? [])];
  if (all.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-slate-400 dark:text-[#777]">
        No exceptions — this pod is fully sealed.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 dark:divide-[#1a1a1a]">
      <AnimatePresence initial={false}>
        {all.map((rule) => (
          <ExceptionRow key={ruleKey(rule)} rule={rule} onRemove={() => onRemove(pod, rule)} />
        ))}
      </AnimatePresence>
    </ul>
  );
}
