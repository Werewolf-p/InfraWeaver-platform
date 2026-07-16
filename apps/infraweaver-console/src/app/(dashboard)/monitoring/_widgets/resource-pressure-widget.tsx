"use client";

import type { Signal } from "@/lib/observability-signals";
import { SignalCard } from "./signal-card";

interface TopConsumer {
  pod: string;
  namespace: string;
  memory_pct: number;
}

interface ResourcePressureWidgetProps {
  signal?: Signal;
  recentOom: number;
  nodesNotReady: number;
  maxMemPct: number;
  topMem: TopConsumer[];
  isLoading?: boolean;
  isError?: boolean;
}

function Stat({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-950/40 px-3 py-2 text-center">
      <p className={`text-lg font-bold ${danger ? "text-red-500" : "text-gray-900 dark:text-white"}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">{label}</p>
    </div>
  );
}

/** OOMKills + not-ready nodes + top memory consumers — predictors of the next crashloop. */
export function ResourcePressureWidget({ signal, recentOom, nodesNotReady, maxMemPct, topMem, isLoading, isError }: ResourcePressureWidgetProps) {
  return (
    <SignalCard source="resources" signal={signal} isLoading={isLoading} isError={isError}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="OOMKills 6h" value={recentOom} danger={recentOom > 0} />
          <Stat label="NotReady" value={nodesNotReady} danger={nodesNotReady > 0} />
          <Stat label="Peak mem" value={`${maxMemPct}%`} danger={maxMemPct >= 90} />
        </div>
        {topMem.length > 0 ? (
          <ul className="space-y-1">
            {topMem.slice(0, 3).map((consumer) => (
              <li key={`${consumer.namespace}/${consumer.pod}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-gray-700 dark:text-[#d4d4d4]">{consumer.namespace}/{consumer.pod}</span>
                <span className="shrink-0 text-gray-500 dark:text-[#888]">{consumer.memory_pct}%</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SignalCard>
  );
}
