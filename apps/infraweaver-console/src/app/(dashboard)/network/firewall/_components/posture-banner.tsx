"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ShieldCheck, ShieldAlert, ShieldOff, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropSparkline } from "./drop-sparkline";
import { EASE_OUT } from "./motion";

interface PostureBannerProps {
  dataplaneLive: boolean;
  stats: { pods: number; flows: number; dropsPerSec: number };
  dropHistory: number[];
}

type Posture = "offline" | "sealed" | "holding";

function posture(dataplaneLive: boolean, pods: number): Posture {
  if (!dataplaneLive) return "offline";
  return pods === 0 ? "sealed" : "holding";
}

const COPY: Record<Posture, { title: string; sub: string; Icon: typeof ShieldCheck; tone: string; ring: string }> = {
  offline: {
    title: "Dataplane waking up",
    sub: "Cilium + Hubble aren't reporting yet. Denials will surface here the moment enforcement is live.",
    Icon: ShieldOff,
    tone: "text-[var(--az-text-muted)]",
    ring: "ring-[var(--az-border)]",
  },
  sealed: {
    title: "Sealed",
    sub: "Every pod is default-deny. Nothing reaches in or out unless you've opened it on purpose — nothing is being blocked right now.",
    Icon: ShieldCheck,
    tone: "text-[var(--az-success)]",
    ring: "ring-emerald-500/30",
  },
  holding: {
    title: "Holding the line",
    sub: "Default-deny is doing its job. The flows below were blocked — open the ones you meant to allow, leave the rest sealed.",
    Icon: ShieldAlert,
    tone: "text-amber-400",
    ring: "ring-amber-500/30",
  },
};

function Metric({ label, value, live }: { label: string; value: string; live?: boolean }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-1.5">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="tabular text-xl font-semibold tracking-tight text-slate-900 dark:text-[#f2f2f2]"
          >
            {value}
          </motion.span>
        </AnimatePresence>
        {live ? <span className="live-dot h-1.5 w-1.5 rounded-full bg-[var(--az-danger)]" aria-hidden /> : null}
      </div>
      <span className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-[#888]">{label}</span>
    </div>
  );
}

export function PostureBanner({ dataplaneLive, stats, dropHistory }: PostureBannerProps) {
  const reduce = useReducedMotion();
  const p = posture(dataplaneLive, stats.pods);
  const { title, sub, Icon, tone, ring } = COPY[p];

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: EASE_OUT }}
      aria-label={`Network posture: ${title}`}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-[#262626] dark:bg-[#141414]"
    >
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="flex items-start gap-4">
          <span
            className={cn(
              "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-slate-50 ring-1 dark:bg-[#0f0f0f]",
              ring,
            )}
          >
            {p === "holding" && !reduce ? (
              <motion.span
                className="absolute inset-0 rounded-xl ring-2 ring-amber-500/40"
                animate={{ opacity: [0.6, 0, 0.6], scale: [1, 1.18, 1] }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                aria-hidden
              />
            ) : null}
            <Icon className={cn("h-6 w-6", tone)} aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className={cn("text-lg font-semibold tracking-tight", tone)}>{title}</h2>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-[#2a2a2a] dark:bg-[#0f0f0f] dark:text-[#888]">
                default-deny
              </span>
            </div>
            <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-slate-600 dark:text-[#a8a8a8]">{sub}</p>
          </div>
        </div>

        <div className="flex items-center gap-6 sm:gap-8">
          <Metric label="Pods denied" value={String(stats.pods)} />
          <Metric label="Blocked flows" value={String(stats.flows)} />
          <Metric label="Drops/sec" value={stats.dropsPerSec.toFixed(stats.dropsPerSec >= 10 ? 0 : 1)} live={stats.dropsPerSec > 0} />
          <div className="hidden flex-col items-end gap-1 md:flex">
            <DropSparkline values={dropHistory} color={stats.dropsPerSec > 0 ? "var(--az-danger)" : "var(--az-success)"} />
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-slate-400 dark:text-[#777]">
              <Activity className="h-3 w-3" aria-hidden />
              last ~{Math.round((48 * 15) / 60)} min
            </span>
          </div>
        </div>
      </div>
    </motion.section>
  );
}
