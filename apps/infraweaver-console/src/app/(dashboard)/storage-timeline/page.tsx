"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

interface Volume {
  name: string;
  state?: string;
  size?: number;
  actualSize?: number;
  numberOfReplicas?: number;
  robustness?: string;
}

export default function StorageTimelinePage() {
  const { data, isLoading } = useQuery({
    queryKey: ["longhorn", "volumes"],
    queryFn: async () => {
      const res = await fetch("/api/longhorn/volumes");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ volumes?: Volume[] }>;
    },
  });

  const volumes = data?.volumes ?? [];
  const totalGi = volumes.reduce((s, v) => s + (v.size ?? 0) / (1024 ** 3), 0);
  const usedGi = volumes.reduce((s, v) => s + (v.actualSize ?? 0) / (1024 ** 3), 0);
  const healthy = volumes.filter(v => v.robustness === "healthy" || v.state === "attached").length;

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={HardDrive} title="Storage Timeline" />
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><HardDrive className="w-5 h-5 text-slate-500 dark:text-slate-400" />Storage Timeline</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Longhorn volume usage overview</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "Total Capacity", value: `${totalGi.toFixed(1)} GiB`, color: "text-gray-900 dark:text-white" },
          { label: "Used", value: `${usedGi.toFixed(1)} GiB`, color: "text-indigo-400" },
          { label: "Healthy Volumes", value: `${healthy}/${volumes.length}`, color: "text-green-400" },
        ].map(s => (
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
            {volumes.map(v => {
              const total = (v.size ?? 0) / (1024 ** 3);
              const used = (v.actualSize ?? 0) / (1024 ** 3);
              const pct = total > 0 ? Math.round((used / total) * 100) : 0;
              return (
                <tr key={v.name} className="border-b border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">{v.name}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${v.robustness === "healthy" ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"}`}>{v.state ?? "unknown"}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-slate-700 dark:text-slate-300">{total.toFixed(1)}</td>
                  <td className="px-4 py-3 text-sm text-right text-slate-700 dark:text-slate-300">{used.toFixed(1)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <div className="w-20 h-2 bg-gray-100 dark:bg-white/10 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${pct > 80 ? "bg-red-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {volumes.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No volumes found</div>}
      </div>
    </motion.div>
  );
}
