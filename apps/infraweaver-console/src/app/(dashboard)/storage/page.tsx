"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { HardDrive, AlertCircle, CheckCircle2 } from "lucide-react";
import { formatBytes, cn } from "@/lib/utils";
import { StoragePieChart } from "@/components/charts/PieChart";
import { CollapsibleSection } from "@/components/ui/collapsible-section";

interface BreakdownEntry {
  name: string;
  totalGi: number;
  pvcCount: number;
  color: string;
}

export default function StoragePage() {
  const { data: volumes, isLoading } = useQuery({
    queryKey: ["longhorn", "volumes"],
    queryFn: async () => {
      const res = await fetch("/api/longhorn/volumes");
      if (!res.ok) throw new Error("Failed to fetch volumes");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: breakdownData } = useQuery<{ breakdown: BreakdownEntry[] }>({
    queryKey: ["storage", "breakdown"],
    queryFn: async () => {
      const res = await fetch("/api/storage/breakdown");
      return res.json();
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Storage</h2>
        <p className="text-sm text-slate-400">Longhorn distributed storage volumes</p>
      </div>

      {breakdownData && breakdownData.breakdown.length > 0 && (
        <CollapsibleSection title="Storage by Class" storageKey="storage-breakdown">
          <StoragePieChart
            data={breakdownData.breakdown.map(b => ({ name: b.name, value: b.totalGi, color: b.color }))}
            unit="Gi"
          />
        </CollapsibleSection>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {volumes?.map((vol: { name: string; size: number; actualSize: number; robustness: string; numberOfReplicas: number }) => {
            const usedPct = vol.size > 0 ? Math.round((vol.actualSize / vol.size) * 100) : 0;
            const isHealthy = vol.robustness === "healthy";
            return (
              <motion.div
                key={vol.name}
                whileHover={{ x: 2 }}
                whileTap={{ scale: 0.99 }}
                className="bg-white/5 border border-white/10 rounded-xl p-4"
              >
                <div className="flex items-start sm:items-center justify-between mb-2 gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <HardDrive className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-white truncate">{vol.name}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-xs text-slate-400">{vol.numberOfReplicas}x</span>
                    <div className="flex items-center gap-1.5">
                      {isHealthy ? (
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-red-400" />
                      )}
                      <span className={cn("text-xs font-medium", isHealthy ? "text-green-400" : "text-red-400")}>
                        {vol.robustness}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 bg-slate-800 rounded-full h-1.5">
                    <div
                      className={cn("h-1.5 rounded-full transition-all", usedPct > 80 ? "bg-red-500" : usedPct > 60 ? "bg-yellow-500" : "bg-indigo-500")}
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-400 whitespace-nowrap text-right min-w-[80px]">
                    {formatBytes(vol.actualSize ?? 0)} / {formatBytes(vol.size ?? 0)}
                  </span>
                </div>
              </motion.div>
            );
          }) ?? (
            <div className="text-center py-16 text-slate-500">
              <HardDrive className="w-10 h-10 mb-3 mx-auto opacity-30" />
              <p>No volumes found or Longhorn API unavailable</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
