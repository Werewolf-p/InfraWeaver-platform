"use client";

import type { Signal } from "@/lib/observability-signals";
import { SignalCard } from "./signal-card";

export interface PostureData {
  score: number;
  grade: string;
  breakdown?: {
    pods?: { rootPods?: number; privEscPods?: number; noLimitsPods?: number };
    namespaces?: { unprotected?: string[] };
  };
  trend?: string;
}

interface PostureWidgetProps {
  signal?: Signal;
  posture?: PostureData;
  isLoading?: boolean;
  isError?: boolean;
}

/** Security posture score/grade + the top deductions dragging it down. */
export function PostureWidget({ signal, posture, isLoading, isError }: PostureWidgetProps) {
  const pods = posture?.breakdown?.pods;
  const unprotected = posture?.breakdown?.namespaces?.unprotected?.length ?? 0;

  return (
    <SignalCard source="posture" signal={signal} isLoading={isLoading} isError={isError}>
      {posture ? (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900 dark:text-white">{posture.score}</span>
            <span className="text-sm text-gray-500 dark:text-[#888]">grade {posture.grade} · {posture.trend ?? "stable"}</span>
          </div>
          <ul className="space-y-1 text-xs text-gray-600 dark:text-[#b8b8b8]">
            <li>{pods?.rootPods ?? 0} root pods · {pods?.privEscPods ?? 0} priv-esc</li>
            <li>{pods?.noLimitsPods ?? 0} pods without limits</li>
            <li>{unprotected} namespaces without a network policy</li>
          </ul>
        </div>
      ) : null}
    </SignalCard>
  );
}
