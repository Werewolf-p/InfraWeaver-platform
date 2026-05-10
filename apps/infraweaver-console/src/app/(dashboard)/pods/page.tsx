"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Server } from "lucide-react";
import { cn } from "@/lib/utils";

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  nodeName: string;
  createdAt: string;
}

function statusColor(status: string) {
  const s = status.toLowerCase();
  if (s === "running") return "bg-green-500/10 text-green-400 border-green-500/20";
  if (s === "pending") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  if (s === "failed") return "bg-red-500/10 text-red-400 border-red-500/20";
  if (s === "succeeded" || s === "completed") return "bg-blue-500/10 text-blue-400 border-blue-500/20";
  return "bg-slate-500/10 text-slate-400 border-slate-500/20";
}

export default function PodsPage() {
  const [nsFilter, setNsFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pods"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Pod[]>;
    },
  });

  const pods = data ?? [];
  const namespaces = ["all", ...new Set(pods.map(p => p.namespace))];
  const statuses = ["all", ...new Set(pods.map(p => p.status.toLowerCase()))];

  const filtered = pods.filter(p =>
    (nsFilter === "all" || p.namespace === nsFilter) &&
    (statusFilter === "all" || p.status.toLowerCase() === statusFilter) &&
    (!search || p.name.toLowerCase().includes(search.toLowerCase()))
  );

  if (isLoading) return <div className="space-y-4">{[...Array(6)].map((_, i) => <div key={i} className="h-14 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Server className="w-5 h-5 text-slate-400" />Multi-Namespace Pod View</h2>
          <p className="text-sm text-slate-400">{filtered.length} / {pods.length} pods</p>
        </div>
        <button onClick={() => void refetch()} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">Refresh</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select value={nsFilter} onChange={e => setNsFilter(e.target.value)} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
          {namespaces.map(ns => <option key={ns} value={ns}>{ns === "all" ? "All namespaces" : ns}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
          {statuses.map(s => <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pods..." className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50 w-48" />
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Node</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Containers</th>
          </tr></thead>
          <tbody>
            {filtered.map(p => (
              <tr key={`${p.namespace}/${p.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium max-w-xs truncate">{p.name}</td>
                <td className="px-4 py-3 text-sm text-slate-400">{p.namespace}</td>
                <td className="px-4 py-3 text-center">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full border", statusColor(p.status))}>{p.status}</span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">{p.nodeName}</td>
                <td className="px-4 py-3 text-xs text-slate-400">{Array.isArray(p.containers) ? p.containers.join(", ") : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No pods match filters</div>}
      </div>
    </motion.div>
  );
}
