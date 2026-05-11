"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Clock} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface CronJob {
  namespace: string;
  name: string;
  schedule: string;
  suspended: boolean;
  lastSchedule: string | null;
  active: number;
  image: string;
}

export default function CronJobsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["cluster", "cronjobs"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/cronjobs");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ cronjobs: CronJob[] }>;
    },
  });

  const cronjobs = data?.cronjobs ?? [];
  const active = cronjobs.filter(c => !c.suspended).length;

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Clock} title="CronJobs" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Calendar className="w-5 h-5 text-slate-400" />CronJob Manager</h2>
          <p className="text-sm text-slate-400">{active} active / {cronjobs.length} total</p>
        </div>
        <button onClick={() => void refetch()} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">
          Refresh
        </button>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Schedule</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Last Run</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Active Jobs</th>
            <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
          </tr></thead>
          <tbody>
            {cronjobs.map(cj => (
              <tr key={`${cj.namespace}/${cj.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium">{cj.name}</td>
                <td className="px-4 py-3 text-sm text-slate-400">{cj.namespace}</td>
                <td className="px-4 py-3 text-sm text-slate-300 font-mono">{cj.schedule}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{cj.lastSchedule ? new Date(cj.lastSchedule).toLocaleString() : "Never"}</td>
                <td className="px-4 py-3 text-sm text-center text-slate-300">{cj.active}</td>
                <td className="px-4 py-3 text-center">
                  <span className={cn("text-xs px-2 py-0.5 rounded-full", cj.suspended ? "bg-yellow-500/10 text-yellow-400" : "bg-green-500/10 text-green-400")}>
                    {cj.suspended ? "Suspended" : "Active"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {cronjobs.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No CronJobs found</div>}
      </div>
    </motion.div>
  );
}
