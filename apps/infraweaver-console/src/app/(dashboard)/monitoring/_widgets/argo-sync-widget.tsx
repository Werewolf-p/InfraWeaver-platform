"use client";

import { SegmentedBar } from "@/components/ui/segmented-bar";
import type { ArgoAppSummary } from "@/lib/argocd-apps";
import type { Signal } from "@/lib/observability-signals";
import { SignalCard } from "./signal-card";

interface ArgoSyncWidgetProps {
  signal?: Signal;
  summary?: ArgoAppSummary;
  isLoading?: boolean;
  isError?: boolean;
}

/** ArgoCD sync/health rollup — catches drift before selfHeal cascades. */
export function ArgoSyncWidget({ signal, summary, isLoading, isError }: ArgoSyncWidgetProps) {
  return (
    <SignalCard source="argocd" signal={signal} isLoading={isLoading} isError={isError}>
      {summary ? (
        <div className="space-y-3">
          <SegmentedBar
            segments={[
              { label: "Healthy", value: summary.healthy, className: "bg-emerald-500" },
              { label: "Progressing", value: summary.progressing, className: "bg-sky-500" },
              { label: "Degraded", value: summary.degraded, className: "bg-red-500" },
              { label: "OutOfSync", value: summary.outOfSync, className: "bg-amber-500" },
            ]}
          />
          <p className="text-xs text-gray-500 dark:text-[#888]">
            {summary.total} apps · {summary.issues} with issues
          </p>
        </div>
      ) : null}
    </SignalCard>
  );
}
