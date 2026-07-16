"use client";

import type { ReliabilityComponentScore } from "@/lib/reliability";
import type { Signal } from "@/lib/observability-signals";
import { SignalCard } from "./signal-card";

export interface ReliabilityData {
  score: number;
  grade: string;
  components?: Partial<Record<"nodes" | "argocd" | "uptime" | "storage" | "backups", ReliabilityComponentScore>>;
}

interface ReliabilityWidgetProps {
  signal?: Signal;
  reliability?: ReliabilityData;
  isLoading?: boolean;
  isError?: boolean;
}

const COMPONENT_LABELS: Array<{ key: keyof NonNullable<ReliabilityData["components"]>; label: string }> = [
  { key: "nodes", label: "Nodes" },
  { key: "argocd", label: "ArgoCD" },
  { key: "uptime", label: "Uptime" },
  { key: "storage", label: "Storage" },
  { key: "backups", label: "Backups" },
];

function barColor(status: ReliabilityComponentScore["status"] | undefined): string {
  if (status === "critical") return "bg-red-500";
  if (status === "warning") return "bg-amber-500";
  return "bg-emerald-500";
}

/** One-number reliability composite + the five weighted sub-scores as mini bars. */
export function ReliabilityWidget({ signal, reliability, isLoading, isError }: ReliabilityWidgetProps) {
  const components = reliability?.components;

  return (
    <SignalCard source="reliability" signal={signal} isLoading={isLoading} isError={isError}>
      {reliability ? (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-gray-900 dark:text-white">{reliability.score}</span>
            <span className="text-sm text-gray-500 dark:text-[#888]">grade {reliability.grade}</span>
          </div>
          <div className="space-y-1.5">
            {COMPONENT_LABELS.map(({ key, label }) => {
              const component = components?.[key];
              const score = component?.score ?? 0;
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-gray-500 dark:text-[#888]">{label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
                    <div className={`h-full rounded-full ${barColor(component?.status)}`} style={{ width: `${score}%` }} />
                  </div>
                  <span className="w-7 shrink-0 text-right text-[11px] text-gray-500 dark:text-[#888]">{score}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </SignalCard>
  );
}
