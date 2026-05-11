"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { HardDrive, Database} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface PV {
  name: string;
  capacity: string;
  storageClass: string;
  accessModes: string[];
  reclaimPolicy: string;
  status: string;
  claimRef: string;
}

interface PVC {
  namespace: string;
  name: string;
  storageClass: string;
  accessModes: string[];
  requestedStorage: string;
  capacity: string;
  status: string;
  volumeName: string;
}

export default function PvBrowserPage() {
  const [activeTab, setActiveTab] = useState<"pv" | "pvc">("pv");
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["storage", "pvs"],
    queryFn: async () => {
      const res = await fetch("/api/storage/pvs");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ pvs: PV[]; pvcs: PVC[] }>;
    },
  });

  const pvs = data?.pvs ?? [];
  const pvcs = data?.pvcs ?? [];

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Database} title="PV Browser" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><HardDrive className="w-5 h-5 text-slate-400" />Persistent Volume Browser</h2>
        <p className="text-sm text-slate-400">Explore PVs and PVCs across the cluster</p>
      </div>
      <div className="flex gap-2">
        {(["pv", "pvc"] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)} className={cn("px-4 py-2 rounded-lg text-sm font-medium border transition-colors uppercase", activeTab === t ? "bg-indigo-500/20 border-indigo-500/30 text-indigo-300" : "bg-white/5 border-white/10 text-slate-400 hover:text-white")}>
            {t}s ({t === "pv" ? pvs.length : pvcs.length})
          </button>
        ))}
      </div>
      {activeTab === "pv" ? (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Capacity</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Storage Class</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Claim</th>
            </tr></thead>
            <tbody>
              {pvs.map(pv => (
                <tr key={pv.name} onClick={() => setSelected(selected === pv.name ? null : pv.name)} className="border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer">
                  <td className="px-4 py-3 text-sm text-white font-medium">{pv.name}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">{pv.capacity}</td>
                  <td className="px-4 py-3 text-sm text-slate-400">{pv.storageClass}</td>
                  <td className="px-4 py-3"><span className={cn("text-xs px-2 py-0.5 rounded-full", pv.status === "Bound" ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-400")}>{pv.status}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-500">{pv.claimRef || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
          <table className="w-full">
            <thead><tr className="border-b border-white/10">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Namespace</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Requested</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Volume</th>
            </tr></thead>
            <tbody>
              {pvcs.map(pvc => (
                <tr key={`${pvc.namespace}/${pvc.name}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="px-4 py-3 text-sm text-white font-medium">{pvc.name}</td>
                  <td className="px-4 py-3 text-sm text-slate-400">{pvc.namespace}</td>
                  <td className="px-4 py-3 text-sm text-slate-300">{pvc.requestedStorage}</td>
                  <td className="px-4 py-3"><span className={cn("text-xs px-2 py-0.5 rounded-full", pvc.status === "Bound" ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400")}>{pvc.status}</span></td>
                  <td className="px-4 py-3 text-xs text-slate-500">{pvc.volumeName || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}
