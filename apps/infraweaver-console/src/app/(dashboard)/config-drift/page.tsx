"use client";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Database, Trash2 } from "lucide-react";

interface DriftEntry {
  namespace: string;
  name: string;
  kind: string;
  replicas: number;
  image: string;
  capturedAt: string;
  currentReplicas: number;
  currentImage: string;
  drifted: boolean;
}

export default function ConfigDriftPage() {
  const qc = useQueryClient();
  const [baselineCaptured, setBaselineCaptured] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["config-drift"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/config-drift");
      if (!res.ok) throw new Error("Failed");
      const d = await res.json() as { drift: DriftEntry[]; baselineCaptured: boolean };
      setBaselineCaptured(d.baselineCaptured);
      return d;
    },
  });

  const drift = data?.drift ?? [];
  const drifted = drift.filter(d => d.drifted);

  const captureMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cluster/config-drift", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "capture" }) });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => { toast.success("Baseline captured"); void qc.invalidateQueries({ queryKey: ["config-drift"] }); },
    onError: () => toast.error("Failed to capture baseline"),
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cluster/config-drift", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => { toast.success("Baseline cleared"); setBaselineCaptured(false); void qc.invalidateQueries({ queryKey: ["config-drift"] }); },
  });

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-slate-400" />Config Drift Detector</h2>
          <p className="text-sm text-slate-400">Compare current state vs captured baseline</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => captureMutation.mutate()} disabled={captureMutation.isPending} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            <Database className="w-4 h-4" />{captureMutation.isPending ? "Capturing..." : "Capture Baseline"}
          </button>
          {baselineCaptured && (
            <button onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-sm text-red-300 hover:bg-red-500/30 transition-colors">
              <Trash2 className="w-4 h-4" />Clear
            </button>
          )}
        </div>
      </div>

      {!baselineCaptured ? (
        <div className="py-16 text-center text-slate-500">
          <Database className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No baseline captured yet. Click "Capture Baseline" to start monitoring drift.</p>
        </div>
      ) : drifted.length === 0 ? (
        <div className="py-16 text-center text-green-400">
          <p className="text-lg font-semibold">✓ No drift detected</p>
          <p className="text-sm text-slate-400 mt-1">All deployments match the baseline</p>
        </div>
      ) : (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Baseline Image</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Current Image</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-400">Replicas</th>
            </tr></thead>
            <tbody>
              {drifted.map(d => (
                <tr key={`${d.namespace}/${d.name}`} className="border-b border-white/5 bg-red-500/5">
                  <td className="px-4 py-3 text-sm text-white font-medium">{d.name}</td>
                  <td className="px-4 py-3 text-sm text-slate-400">{d.namespace}</td>
                  <td className="px-4 py-3 text-xs text-slate-300 font-mono">{d.image}</td>
                  <td className="px-4 py-3 text-xs text-red-400 font-mono">{d.currentImage}</td>
                  <td className="px-4 py-3 text-sm text-center">
                    <span className={d.replicas !== d.currentReplicas ? "text-red-400" : "text-slate-300"}>{d.replicas} → {d.currentReplicas}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
