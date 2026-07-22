"use client";
import { useMemo } from "react";
import { motion } from "framer-motion";
import { HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";

interface Volume {
  name: string;
  state?: string;
  size?: number;
  actualSize?: number;
  numberOfReplicas?: number;
  robustness?: string;
}

const PRESSURE_WARN = 80;
const PRESSURE_CRITICAL = 90;

function stateTone(volume: Volume): string {
  const attached = volume.state === "attached";
  const healthy = volume.robustness === "healthy";
  if (attached && healthy) return "bg-green-500/10 text-green-500 dark:text-green-400";
  if (attached) return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
  return "bg-slate-500/10 text-slate-500 dark:text-slate-400";
}

function barTone(pct: number): string {
  if (pct >= PRESSURE_CRITICAL) return "bg-red-500";
  if (pct >= PRESSURE_WARN) return "bg-amber-500";
  return "bg-indigo-500";
}

export function StorageTimelineView() {
  const { data, isLoading } = useApiQuery<{ volumes?: Volume[] }>({
    queryKey: ["longhorn", "volumes"],
    path: "/api/longhorn/volumes",
  });

  const volumes = useMemo(() => data?.volumes ?? [], [data?.volumes]);
  const totalGi = volumes.reduce((s, v) => s + (v.size ?? 0) / (1024 ** 3), 0);
  const usedGi = volumes.reduce((s, v) => s + (v.actualSize ?? 0) / (1024 ** 3), 0);
  const healthy = volumes.filter((v) => v.robustness === "healthy").length;

  const rows = useMemo(() => {
    return volumes
      .map((v) => {
        const total = (v.size ?? 0) / (1024 ** 3);
        const used = (v.actualSize ?? 0) / (1024 ** 3);
        const pct = total > 0 ? Math.round((used / total) * 100) : 0;
        return { volume: v, total, used, pct };
      })
      .sort((a, b) => b.pct - a.pct);
  }, [volumes]);

  const underPressure = rows.filter((r) => r.pct >= PRESSURE_WARN).length;

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={HardDrive} title="Storage Timeline" description="Longhorn volume usage overview — most-full volumes first" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Total Capacity", value: `${totalGi.toFixed(1)} GiB`, color: "text-gray-900 dark:text-white" },
          { label: "Used", value: `${usedGi.toFixed(1)} GiB`, color: "text-indigo-400" },
          { label: "Healthy Volumes", value: `${healthy}/${volumes.length}`, color: healthy === volumes.length && volumes.length > 0 ? "text-green-500 dark:text-green-400" : "text-yellow-600 dark:text-yellow-400" },
          { label: "Under Pressure (≥80%)", value: `${underPressure}`, color: underPressure > 0 ? "text-amber-600 dark:text-amber-400" : "text-green-500 dark:text-green-400" },
        ].map((s) => (
          <div key={s.label} className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>
      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-gray-200 dark:border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Volume</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">State</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Size (GiB)</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Used (GiB)</th>
            <th className="text-right px-4 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400">Utilization</th>
          </tr></thead>
          <tbody>
            {rows.map(({ volume: v, total, used, pct }) => (
              <tr
                key={v.name}
                className={cn(
                  "border-b border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors",
                  pct >= PRESSURE_CRITICAL && "bg-red-500/[0.04] dark:bg-red-500/5",
                )}
              >
                <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">{v.name}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn("text-xs px-2 py-0.5 rounded-full", stateTone(v))}
                    title={`state: ${v.state ?? "unknown"} · robustness: ${v.robustness ?? "unknown"}`}
                  >
                    {v.state ?? "unknown"}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-right text-slate-700 dark:text-slate-300 tabular-nums">{total.toFixed(1)}</td>
                <td className="px-4 py-3 text-sm text-right text-slate-700 dark:text-slate-300 tabular-nums">{used.toFixed(1)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <div
                      role="progressbar"
                      aria-valuenow={pct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${v.name} utilization ${pct}%`}
                      className="w-20 h-2 bg-gray-100 dark:bg-white/10 rounded-full overflow-hidden"
                    >
                      <div className={cn("h-full rounded-full", barTone(pct))} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={cn(
                      "text-xs tabular-nums w-10 text-right",
                      pct >= PRESSURE_CRITICAL ? "font-semibold text-red-500 dark:text-red-400"
                        : pct >= PRESSURE_WARN ? "font-semibold text-amber-600 dark:text-amber-400"
                          : "text-slate-500 dark:text-slate-400",
                    )}>{pct}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {volumes.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No volumes found</div>}
      </div>
    </motion.div>
  );
}
