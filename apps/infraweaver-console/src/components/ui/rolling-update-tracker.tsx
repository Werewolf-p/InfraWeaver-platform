"use client";
import { memo } from "react";
import { useQuery } from "@tanstack/react-query";

interface Rollout {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  updated: number;
  phase: string;
}

interface RolloutRowProps {
  rollout: Rollout;
}

const RolloutRow = memo(function RolloutRow({ rollout }: RolloutRowProps) {
  const pct = rollout.desired > 0 ? Math.round((rollout.ready / rollout.desired) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-900 dark:text-white font-medium">{rollout.name}</span>
        <span className="text-slate-500 dark:text-slate-400">{rollout.ready}/{rollout.desired} ready</span>
      </div>
      <div className="h-2 bg-gray-100 dark:bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-indigo-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span>{rollout.namespace}</span>
        <span className="capitalize">{rollout.phase}</span>
      </div>
    </div>
  );
});

export function RollingUpdateTracker() {
  const { data } = useQuery({
    queryKey: ["cluster", "rollout"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/rollout");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ rollouts?: Rollout[] }>;
    },
    refetchInterval: 5000,
  });
  const rollouts = data?.rollouts ?? [];
  if (rollouts.length === 0) return (
    <div className="text-sm text-slate-500 py-4 text-center">No active rollouts</div>
  );
  return (
    <div className="space-y-3">
      {rollouts.map(r => (
        <RolloutRow key={`${r.namespace}/${r.name}`} rollout={r} />
      ))}
    </div>
  );
}
