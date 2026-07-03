"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import Link from "next/link";
import { CheckCircle2, ExternalLink, Lock, ShieldOff, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { podDeniesForPods, podKey } from "../types";
import { useFirewall } from "../use-firewall";
import { PodCell } from "./pod-cell";
import { LearnModeCard } from "./learn-mode-card";
import { EASE_OUT } from "./motion";

interface AppFirewallPanelProps {
  /** Namespace the app's pods run in. */
  namespace: string;
  /** The pods that make up the app (frontend, database, …). */
  podNames: readonly string[];
}

/**
 * App-scoped slice of the Pod Security firewall surface: every pod that makes
 * up one app (an ArgoCD application or a WordPress site), each with its blocked
 * flows, one-click allows, and active exceptions. Reuses the exact components +
 * actions that power the fleet-wide /network/firewall grid (PodCell,
 * useFirewall) so behaviour can never drift. Cross-links back to the fleet view.
 */
export function AppFirewallPanel({ namespace, podNames }: AppFirewallPanelProps) {
  const reduce = useReducedMotion();
  const fw = useFirewall();
  const [bothSides, setBothSides] = useState(true);

  const pods = useMemo(
    () => podDeniesForPods(fw.pods, namespace, podNames),
    [fw.pods, namespace, podNames],
  );

  const hasDenies = pods.some((pod) => pod.ingress.length > 0 || pod.egress.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label
          className="flex cursor-pointer items-center gap-2 text-xs text-slate-600 dark:text-[#aaa]"
          title="When you open a pod-to-pod flow, also open the matching rule on the other pod so both ends agree."
        >
          <span>Mirror pod-to-pod</span>
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
        <Link
          href="/network/firewall"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 dark:border-[#2a2a2a] dark:text-[#ddd] dark:hover:bg-[#1a1a1a]"
        >
          View fleet-wide firewall
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      <LearnModeCard namespace={namespace} podNames={podNames} onChanged={fw.reload} />

      {!fw.dataplaneLive && !fw.loading && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            The Cilium + Hubble dataplane isn&apos;t reporting denials yet. Once enforcement is live, every blocked
            ingress and egress for this app&apos;s pods shows up here automatically.
          </p>
        </div>
      )}

      {fw.error && !fw.data && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
          Couldn&apos;t load denials: {fw.error}
        </p>
      )}

      {fw.loading && !fw.data ? (
        <div className="h-40 rounded-xl border border-slate-200 shimmer-bg dark:border-[#262626]" />
      ) : pods.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-600 dark:border-[#2a2a2a] dark:text-[#aaa]">
          No pods are currently running for this app, so there is nothing to firewall yet.
        </p>
      ) : (
        <>
          {fw.dataplaneLive && !hasDenies && (
            <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50/50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/[0.04] dark:text-emerald-200">
              <Lock className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                All {pods.length === 1 ? "of this app's pod is" : `${pods.length} of this app's pods are`} sealed —
                nothing denied in the last {fw.windowMinutes}m. Expand a pod to review its active exceptions.
              </span>
            </div>
          )}
          <LayoutGroup>
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
              {pods.map((pod) => (
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
            </div>
          </LayoutGroup>
        </>
      )}

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
