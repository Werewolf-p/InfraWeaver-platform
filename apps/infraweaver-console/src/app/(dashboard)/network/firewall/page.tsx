"use client";

import { useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { ShieldCheck, RefreshCw, ShieldOff, Lock, CheckCircle2, XCircle } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { cn } from "@/lib/utils";
import { podKey } from "./types";
import { useFirewall } from "./use-firewall";
import { PostureBanner } from "./_components/posture-banner";
import { LiveFeed } from "./_components/live-feed";
import { PodCell } from "./_components/pod-cell";
import { EASE_OUT } from "./_components/motion";

export default function FirewallPage() {
  const reduce = useReducedMotion();
  const fw = useFirewall();
  const [bothSides, setBothSides] = useState(true);

  const showGrid = fw.dataplaneLive && fw.pods.length > 0;
  const showSealed = fw.dataplaneLive && fw.pods.length === 0 && !fw.loading;

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        icon={ShieldCheck}
        title="Pod security"
        description="Every pod is sealed by default. Watch what the airgap blocks, open a path in one click, re-seal it whenever."
        badge={`${fw.windowMinutes}m window`}
        actions={
          <div className="flex items-center gap-3">
            <label
              className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-[#aaa]"
              title="When you open a pod-to-pod flow, also open the matching rule on the other pod so both ends agree."
            >
              <span className="hidden sm:inline">Mirror pod-to-pod</span>
              <button
                type="button"
                role="switch"
                aria-checked={bothSides}
                aria-label="Mirror pod-to-pod allows on both ends"
                onClick={() => setBothSides((v) => !v)}
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors",
                  bothSides ? "bg-[var(--az-primary)]" : "bg-slate-300 dark:bg-[#333]",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                    bothSides ? "translate-x-4" : "translate-x-0.5",
                  )}
                />
              </button>
            </label>
            <button
              type="button"
              onClick={fw.reload}
              className="flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-50 dark:border-[#2a2a2a] dark:text-[#ddd] dark:hover:bg-[#1a1a1a]"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", fw.loading && "animate-spin")} aria-hidden />
              Refresh
            </button>
          </div>
        }
      />

      <div className="space-y-4">
        <PostureBanner dataplaneLive={fw.dataplaneLive} stats={fw.stats} dropHistory={fw.dropHistory} />

        <LiveFeed feed={fw.feed} />

        {!fw.dataplaneLive && !fw.loading && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              The Cilium + Hubble dataplane isn&apos;t reporting denials yet. Once enforcement is live, every blocked
              ingress and egress shows up here automatically — nothing else to wire up.
            </p>
          </div>
        )}

        {fw.error && !fw.data && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            Couldn&apos;t load denials: {fw.error}
          </p>
        )}

        {fw.loading && !fw.data && (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-40 rounded-xl border border-slate-200 shimmer-bg dark:border-[#262626]" />
            ))}
          </div>
        )}

        {showSealed && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: EASE_OUT }}
            className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50/50 px-6 py-12 text-center dark:border-emerald-500/20 dark:bg-emerald-500/[0.04]"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-[var(--az-success)] dark:bg-emerald-500/15">
              <Lock className="h-7 w-7" aria-hidden />
            </span>
            <h2 className="text-lg font-semibold text-slate-800 dark:text-[#ededed]">Everything is sealed</h2>
            <p className="max-w-md text-sm text-slate-600 dark:text-[#a8a8a8]">
              Nothing is being denied in the last {fw.windowMinutes} minutes. If a pod tries something new and gets
              blocked — say a plugin download — it&apos;ll appear here, ready for one-click allow.
            </p>
          </motion.div>
        )}

        {showGrid && (
          <LayoutGroup>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
              <AnimatePresence mode="popLayout">
                {fw.pods.map((pod) => (
                  <PodCell
                    key={podKey(pod)}
                    pod={pod}
                    bidirectional={bothSides}
                    rules={fw.rules[podKey(pod)] ?? null}
                    onExpand={fw.loadRules}
                    onAllow={fw.performAllow}
                    onCommit={fw.commitAllowed}
                    onRemove={fw.removeRule}
                  />
                ))}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        )}
      </div>

      <AnimatePresence>
        {fw.toast && (
          <motion.div
            role="status"
            aria-live="polite"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.26, ease: EASE_OUT }}
            className={cn(
              "fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-xl border px-4 py-2.5 text-sm shadow-lg backdrop-blur",
              fw.toast.kind === "ok"
                ? "border-emerald-300/60 bg-emerald-50/95 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200"
                : "border-rose-300/60 bg-rose-50/95 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-200",
            )}
            onClick={fw.dismissToast}
          >
            {fw.toast.kind === "ok" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <XCircle className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span>{fw.toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
