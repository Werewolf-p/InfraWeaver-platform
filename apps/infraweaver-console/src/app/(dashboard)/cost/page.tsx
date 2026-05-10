"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { DollarSign } from "lucide-react";

interface NsCost {
  namespace: string;
  cpuMillicores: number;
  memoryMiB: number;
  monthlyCostUsd: number;
}

export default function CostPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["cluster", "cost"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/cost");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ namespaces: NsCost[]; totalMonthlyCost: number }>;
    },
  });

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  const namespaces = data?.namespaces ?? [];
  const total = data?.totalMonthlyCost ?? 0;
  const chartData = namespaces.map(n => ({ name: n.namespace, cost: n.monthlyCostUsd }));

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><DollarSign className="w-5 h-5 text-slate-400" />Cost Estimation</h2>
        <p className="text-sm text-slate-400">Estimated monthly cloud cost based on resource requests</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-6 text-center">
        <p className="text-sm text-slate-400">Total Monthly Estimate</p>
        <p className="text-4xl font-bold text-white mt-2">${total.toFixed(2)}</p>
        <p className="text-xs text-slate-500 mt-1">CPU: $0.048/vCPU/hr · Memory: $0.006/GB/hr</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
        <h3 className="text-sm font-semibold text-white mb-4">Cost by Namespace</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
            <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} />
            <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
            <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} formatter={(v) => [`$${Number(v).toFixed(2)}`, "Monthly Cost"]} />
            <Bar dataKey="cost" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400">CPU (m)</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400">Memory (MiB)</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400">Monthly Cost</th>
            </tr>
          </thead>
          <tbody>
            {namespaces.map(n => (
              <tr key={n.namespace} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium">{n.namespace}</td>
                <td className="px-4 py-3 text-sm text-right text-slate-300">{n.cpuMillicores}</td>
                <td className="px-4 py-3 text-sm text-right text-slate-300">{n.memoryMiB}</td>
                <td className="px-4 py-3 text-sm text-right text-indigo-300 font-semibold">${n.monthlyCostUsd.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
