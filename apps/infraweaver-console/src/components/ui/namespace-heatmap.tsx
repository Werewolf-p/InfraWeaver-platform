"use client";
import { useQuery } from "@tanstack/react-query";

interface Props { onNamespaceClick?: (ns: string) => void; }

interface PodMetric { namespace: string; cpuPct: number; memPct: number; }

export function NamespaceHeatmap({ onNamespaceClick }: Props) {
  const { data } = useQuery({
    queryKey: ["pod-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/pod-metrics");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ metrics: PodMetric[] }>;
    },
  });
  const metrics = data?.metrics ?? [];
  const byNs = metrics.reduce<Record<string, { cpus: number[]; mems: number[] }>>((acc, m) => {
    if (!acc[m.namespace]) acc[m.namespace] = { cpus: [], mems: [] };
    acc[m.namespace].cpus.push(m.cpuPct);
    acc[m.namespace].mems.push(m.memPct);
    return acc;
  }, {});
  const entries = Object.entries(byNs).map(([ns, { cpus, mems }]) => ({
    ns,
    cpu: Math.round(cpus.reduce((a, b) => a + b, 0) / (cpus.length || 1)),
    mem: Math.round(mems.reduce((a, b) => a + b, 0) / (mems.length || 1)),
  }));
  const color = (pct: number) => pct > 80 ? "bg-red-500/20 border-red-500/30" : pct > 50 ? "bg-yellow-500/20 border-yellow-500/30" : "bg-green-500/10 border-green-500/30";
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {entries.map(e => (
        <button key={e.ns} onClick={() => onNamespaceClick?.(e.ns)} className={`p-3 rounded-lg border text-left transition-all hover:scale-105 ${color(Math.max(e.cpu, e.mem))}`}>
          <div className="text-xs font-medium text-gray-900 dark:text-white truncate">{e.ns}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">CPU: {e.cpu}% / Mem: {e.mem}%</div>
        </button>
      ))}
    </div>
  );
}
