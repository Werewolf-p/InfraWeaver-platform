"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Activity, TrendingDown} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface Container {
  name: string;
  requestCpu: string;
  requestMemory: string;
  limitCpu: string;
  limitMemory: string;
  recommendedCpu: string;
  recommendedMemory: string;
  status: string;
}

interface Recommendation {
  namespace: string;
  pod: string;
  containers: Container[];
}

function statusBadge(status: string) {
  if (status === "over-provisioned") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  if (status === "under-provisioned") return "bg-red-500/10 text-red-400 border-red-500/20";
  return "bg-green-500/10 text-green-400 border-green-500/20";
}

export default function ResourceOptimizerPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["cluster", "resource-recommendations"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/resource-recommendations");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ recommendations: Recommendation[] }>;
    },
  });

  const recs = data?.recommendations ?? [];
  const overProvisioned = recs.flatMap(r => r.containers).filter(c => c.status === "over-provisioned").length;
  const underProvisioned = recs.flatMap(r => r.containers).filter(c => c.status === "under-provisioned").length;

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={TrendingDown} title="Resource Optimizer" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Activity className="w-5 h-5 text-slate-400" />Resource Optimizer</h2>
        <p className="text-sm text-slate-400">Request vs limit recommendations</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Pods Analyzed", value: recs.length, color: "text-white" },
          { label: "Over-provisioned", value: overProvisioned, color: overProvisioned > 0 ? "text-yellow-400" : "text-green-400" },
          { label: "Under-provisioned", value: underProvisioned, color: underProvisioned > 0 ? "text-red-400" : "text-green-400" },
        ].map(s => (
          <div key={s.label} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-400">{s.label}</p>
            <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Pod / Container</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">CPU Request</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">CPU Recommended</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Mem Request</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Mem Recommended</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
          </tr></thead>
          <tbody>
            {recs.flatMap(r => r.containers.map(c => (
              <tr key={`${r.pod}/${c.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3">
                  <p className="text-sm text-white font-medium">{r.pod}</p>
                  <p className="text-xs text-slate-500">{c.name}</p>
                </td>
                <td className="px-4 py-3 text-sm text-slate-400">{r.namespace}</td>
                <td className="px-4 py-3 text-xs text-center text-slate-300 font-mono">{c.requestCpu}</td>
                <td className="px-4 py-3 text-xs text-center text-indigo-300 font-mono">{c.recommendedCpu}</td>
                <td className="px-4 py-3 text-xs text-center text-slate-300 font-mono">{c.requestMemory}</td>
                <td className="px-4 py-3 text-xs text-center text-indigo-300 font-mono">{c.recommendedMemory}</td>
                <td className="px-4 py-3 text-center">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full border", statusBadge(c.status))}>{c.status}</span>
                </td>
              </tr>
            )))}
          </tbody>
        </table>
        {recs.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No recommendations available</div>}
      </div>
    </motion.div>
  );
}
