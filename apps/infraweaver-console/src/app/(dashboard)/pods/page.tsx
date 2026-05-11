"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Server, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { CommandBar } from "@/components/ui/command-bar";
import { cn } from "@/lib/utils";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { PodRowSkeleton } from "@/components/ui/skeleton-card";

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
  const { simpleMode, toggle } = useSimpleMode();

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

  if (isLoading) return (
    <div className="bg-slate-900/60 border border-white/10 rounded-xl overflow-hidden">
      <table className="w-full">
        <tbody>{[...Array(6)].map((_, i) => <PodRowSkeleton key={i} />)}</tbody>
      </table>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Server} title="Pods" subtitle="All pods with live status" />
      <CommandBar
        actions={[
          { label: "Refresh", icon: RefreshCw, onClick: () => void refetch() },
        ]}
        filter={
          <div className="flex flex-wrap items-center gap-2">
            <select value={nsFilter} onChange={e => setNsFilter(e.target.value)} className="px-3 py-2 rounded-lg bg-[#0f0f0f] border border-[#333] text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]/50">
              {namespaces.map(ns => <option key={ns} value={ns}>{ns === "all" ? "All namespaces" : ns}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="px-3 py-2 rounded-lg bg-[#0f0f0f] border border-[#333] text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]/50">
              {statuses.map(s => <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>)}
            </select>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search pods..." className="px-3 py-2 rounded-lg bg-[#0f0f0f] border border-[#333] text-sm text-[#f2f2f2] placeholder:text-[#555] outline-none focus:border-[#0078D4]/50 w-48" />
              <button
                onClick={toggle}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors",
                  simpleMode
                    ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
                    : "border-[#333] text-[#666] hover:text-[#9e9e9e]"
                )}
              >
                {simpleMode ? "Simple" : "Advanced"}
              </button>
          </div>
        }
      />
      <div className="flex items-center justify-between px-4">
        <p className="text-sm text-[#9e9e9e]">{filtered.length} / {pods.length} pods</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
            {!simpleMode && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Node</th>}
            {!simpleMode && <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Containers</th>}
          </tr></thead>
          <tbody>
            {filtered.map(p => (
              <tr key={`${p.namespace}/${p.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium max-w-xs truncate">{p.name}</td>
                <td className="px-4 py-3 text-sm text-slate-400">{p.namespace}</td>
                <td className="px-4 py-3 text-center">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full border", statusColor(p.status))}>{p.status}</span>
                </td>
                {!simpleMode && <td className="px-4 py-3 text-xs text-slate-500">{p.nodeName}</td>}
                {!simpleMode && <td className="px-4 py-3 text-xs text-slate-400">{Array.isArray(p.containers) ? p.containers.join(", ") : ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No pods match filters</div>}
      </div>
    </motion.div>
  );
}
