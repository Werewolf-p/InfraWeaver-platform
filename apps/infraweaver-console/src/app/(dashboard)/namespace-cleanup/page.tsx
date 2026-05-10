"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";

interface Pod {
  name: string;
  namespace: string;
  status: string;
}

interface NsStats {
  namespace: string;
  running: number;
  pending: number;
  failed: number;
  completed: number;
  total: number;
}

export default function NamespaceCleanupPage() {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  const { data: podsData, isLoading } = useQuery({
    queryKey: ["pods"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Pod[]>;
    },
  });

  const pods = podsData ?? [];
  const byNs: Record<string, NsStats> = {};
  for (const pod of pods) {
    if (!byNs[pod.namespace]) byNs[pod.namespace] = { namespace: pod.namespace, running: 0, pending: 0, failed: 0, completed: 0, total: 0 };
    const s = pod.status.toLowerCase();
    byNs[pod.namespace].total++;
    if (s === "running") byNs[pod.namespace].running++;
    else if (s === "pending") byNs[pod.namespace].pending++;
    else if (s === "failed") byNs[pod.namespace].failed++;
    else if (s === "completed" || s === "succeeded") byNs[pod.namespace].completed++;
  }
  const stats = Object.values(byNs);

  const handlePreview = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cluster/namespace-cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true }) });
      const data = await res.json() as { namespaces?: string[] };
      setPreview(data.namespaces ?? []);
      toast.success("Preview loaded");
    } catch {
      toast.error("Failed to preview cleanup");
    } finally {
      setLoading(false);
    }
  };

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Namespace Cleanup</h2>
          <p className="text-sm text-slate-400">Identify namespaces with failed/stale pods</p>
        </div>
        <button onClick={handlePreview} disabled={loading} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors disabled:opacity-50">
          <Trash2 className="w-4 h-4" />
          {loading ? "Loading..." : "Preview Cleanup"}
        </button>
      </div>

      {preview !== null && (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Cleanup Candidates</h3>
          {preview.length === 0 ? (
            <p className="text-sm text-slate-400">No namespaces need cleanup</p>
          ) : (
            <div className="space-y-1">
              {preview.map(ns => (
                <div key={ns} className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <Trash2 className="w-4 h-4 text-red-400" />
                  <span className="text-sm text-red-300">{ns}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-green-400">Running</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-yellow-400">Pending</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-red-400">Failed</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-slate-400">Total</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(s => (
              <tr key={s.namespace} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium">{s.namespace}</td>
                <td className="px-4 py-3 text-sm text-right text-green-400">{s.running}</td>
                <td className="px-4 py-3 text-sm text-right text-yellow-400">{s.pending}</td>
                <td className="px-4 py-3 text-sm text-right text-red-400">{s.failed}</td>
                <td className="px-4 py-3 text-sm text-right text-slate-300">{s.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
