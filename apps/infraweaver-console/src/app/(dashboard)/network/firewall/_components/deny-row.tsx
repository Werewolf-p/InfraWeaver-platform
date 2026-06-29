"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type BlockedDestination,
  type Direction,
  type PodDenies,
  KIND_LABEL,
  flowId,
  isFlowAllowable,
  notAllowableReason,
} from "../types";
import { springSoft } from "./motion";

interface DenyRowProps {
  pod: PodDenies;
  direction: Direction;
  peer: BlockedDestination;
  bidirectional: boolean;
  onAllow: (pod: PodDenies, direction: Direction, peer: BlockedDestination, bidirectional: boolean) => Promise<{ ok: boolean }>;
  onCommit: (id: string) => void;
}

type Status = "idle" | "working" | "done";

export function DenyRow({ pod, direction, peer, bidirectional, onAllow, onCommit }: DenyRowProps) {
  const reduce = useReducedMotion();
  const [status, setStatus] = useState<Status>("idle");
  const [shake, setShake] = useState(false);
  const allowable = isFlowAllowable(direction, peer);
  const id = flowId(pod, direction, peer);

  async function handleAllow() {
    if (!allowable || status !== "idle") return;
    setStatus("working");
    const { ok } = await onAllow(pod, direction, peer, bidirectional);
    if (ok) {
      setStatus("done");
      // Let the success state breathe, then commit removal so the row exits.
      window.setTimeout(() => onCommit(id), reduce ? 120 : 620);
    } else {
      setStatus("idle");
      setShake(true);
      window.setTimeout(() => setShake(false), 420);
    }
  }

  const settled = { opacity: 1, x: 0, y: 0 };
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={shake && !reduce ? { ...settled, x: [0, -5, 5, -3, 3, 0] } : settled}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 24 }}
      transition={{ duration: 0.3 }}
      className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex h-5 shrink-0 items-center rounded bg-slate-100 px-1.5 font-mono text-[10px] uppercase tracking-wide text-slate-500 dark:bg-[#1f1f1f] dark:text-[#999]">
          {KIND_LABEL[peer.kind]}
        </span>
        <span className="truncate font-mono text-[13px] text-slate-800 dark:text-[#e2e2e2]">{peer.target}</span>
        {peer.port ? (
          <span className="shrink-0 font-mono text-xs text-slate-400 dark:text-[#777]">
            :{peer.port}/{(peer.protocol ?? "?").toLowerCase()}
          </span>
        ) : null}
      </div>

      {allowable ? (
        <motion.button
          type="button"
          onClick={handleAllow}
          disabled={status !== "idle"}
          aria-label={`Allow ${peer.target}${peer.port ? ` on port ${peer.port}` : ""} ${direction === "ingress" ? "inbound" : "outbound"} for ${pod.pod}`}
          whileTap={reduce || status !== "idle" ? undefined : { scale: 0.95 }}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
            status === "done"
              ? "bg-[var(--az-success)] text-white"
              : "border border-emerald-300/70 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20",
          )}
        >
          {status === "working" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : status === "done" ? (
            <motion.span initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={springSoft}>
              <Check className="h-3.5 w-3.5" aria-hidden />
            </motion.span>
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden />
          )}
          {status === "working" ? "Opening…" : status === "done" ? "Open" : "Allow"}
        </motion.button>
      ) : (
        <span
          title={notAllowableReason(direction, peer)}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-xs text-slate-400 dark:border-[#2a2a2a] dark:text-[#666]"
        >
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Sealed
        </span>
      )}
    </motion.li>
  );
}
