"use client";
import { useQuery } from "@tanstack/react-query";

interface Rollout {
  name: string;
  namespace: string;
  ready: number;
  desired: number;
  updated: number;
  phase: string;
}

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
      {rollouts.map(r => {
        const pct = r.desired > 0 ? Math.round((r.ready / r.desired) * 100) : 0;
        return (
          <div key={`${r.namespace}/${r.name}`} className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-900 dark:text-white font-medium">{r.name}</span>
              <span className="text-slate-500 dark:text-slate-400">{r.ready}/{r.desired} ready</span>
            </div>
            <div className="h-2 bg-gray-100 dark:bg-white/10 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-indigo-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span>{r.namespace}</span>
              <span className="capitalize">{r.phase}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
