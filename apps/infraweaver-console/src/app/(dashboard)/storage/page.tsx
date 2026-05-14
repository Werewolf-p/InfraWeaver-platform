"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { HardDrive, AlertCircle, CheckCircle2, Search, ArrowUpDown } from "lucide-react";
import { formatBytes, cn } from "@/lib/utils";
import { StoragePieChart } from "@/components/charts/PieChart";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";

interface BreakdownEntry {
  name: string;
  totalGi: number;
  pvcCount: number;
  color: string;
}

export default function StoragePage() {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "usage">("usage");
  const { data: volumes, isLoading, dataUpdatedAt } = useQuery({
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

  const filteredVolumes = useMemo(() => {
    const items = [...(volumes ?? [])].filter((vol: { name: string }) => vol.name.toLowerCase().includes(search.toLowerCase()));
    return items.sort((a: { name: string; size: number; actualSize: number }, b: { name: string; size: number; actualSize: number }) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      const aUsed = a.size > 0 ? a.actualSize / a.size : 0;
      const bUsed = b.size > 0 ? b.actualSize / b.size : 0;
      return bUsed - aUsed;
    });
  }, [search, sortBy, volumes]);

  return (
    <div>
      <PageHeader icon={HardDrive} title="Storage" subtitle="Persistent volumes and storage classes" />
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Storage</h2>
          <p className="text-sm text-slate-400">Longhorn distributed storage volumes</p>
        </div>
        <RefreshCountdown intervalSeconds={60} resetKey={dataUpdatedAt} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search volumes..." className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-400">
          <ArrowUpDown className="h-3.5 w-3.5" />
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as "name" | "usage")} className="bg-transparent text-sm text-white focus:outline-none">
            <option value="usage" className="bg-slate-900">Highest usage</option>
            <option value="name" className="bg-slate-900">Name A-Z</option>
          </select>
        </label>
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
          {filteredVolumes.map((vol: { name: string; size: number; actualSize: number; robustness: string; numberOfReplicas: number }) => {
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
          })}
          {filteredVolumes.length === 0 && (
            <div className="text-center py-16 text-slate-500">
              <HardDrive className="w-10 h-10 mb-3 mx-auto opacity-30" />
              <p>{search ? "No volumes match this search" : "No volumes found or Longhorn API unavailable"}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
