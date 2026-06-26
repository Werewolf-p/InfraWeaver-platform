"use client";
import { memo, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

interface Props { onNamespaceClick?: (ns: string) => void; }

interface PodMetric { namespace: string; cpuPct: number; memPct: number; }

interface NsEntry { ns: string; cpu: number; mem: number; }

interface CellProps {
  entry: NsEntry;
  onNamespaceClick?: (ns: string) => void;
}

function colorClass(pct: number): string {
  if (pct > 80) return "bg-red-500/20 border-red-500/30";
  if (pct > 50) return "bg-yellow-500/20 border-yellow-500/30";
  return "bg-green-500/10 border-green-500/30";
}

const NamespaceCell = memo(function NamespaceCell({ entry, onNamespaceClick }: CellProps) {
  const handleClick = useCallback(() => {
    onNamespaceClick?.(entry.ns);
  }, [onNamespaceClick, entry.ns]);

  const cls = colorClass(Math.max(entry.cpu, entry.mem));

  return (
    <button
      onClick={handleClick}
      className={`p-3 rounded-lg border text-left transition-all hover:scale-105 ${cls}`}
    >
      <div className="text-xs font-medium text-gray-900 dark:text-white truncate">{entry.ns}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">CPU: {entry.cpu}% / Mem: {entry.mem}%</div>
    </button>
  );
});

export function NamespaceHeatmap({ onNamespaceClick }: Props) {
  const { data } = useQuery({
    queryKey: ["pod-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/pod-metrics");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ metrics: PodMetric[] }>;
    },
  });

  const entries = useMemo<NsEntry[]>(() => {
    const metrics = data?.metrics ?? [];
    const byNs = metrics.reduce<Record<string, { cpus: number[]; mems: number[] }>>((acc, m) => {
      if (!acc[m.namespace]) acc[m.namespace] = { cpus: [], mems: [] };
      acc[m.namespace].cpus.push(m.cpuPct);
      acc[m.namespace].mems.push(m.memPct);
      return acc;
    }, {});

    return Object.entries(byNs).map(([ns, { cpus, mems }]) => ({
      ns,
      cpu: Math.round(cpus.reduce((a, b) => a + b, 0) / (cpus.length || 1)),
      mem: Math.round(mems.reduce((a, b) => a + b, 0) / (mems.length || 1)),
    }));
  }, [data?.metrics]);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {entries.map(e => (
        <NamespaceCell key={e.ns} entry={e} onNamespaceClick={onNamespaceClick} />
      ))}
    </div>
  );
}
