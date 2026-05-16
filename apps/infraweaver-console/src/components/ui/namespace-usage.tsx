"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { ResourceBar } from "@/components/ui/resource-bar";

interface NamespaceUsageItem {
  namespace: string;
  podCount: number;
  podLimit: number;
  cpuUsed: number;
  cpuLimit: number;
  memUsed: number;
  memLimit: number;
}

interface NamespaceUsageProps {
  className?: string;
}

export function NamespaceUsage({ className }: NamespaceUsageProps) {
  const { data, isLoading, error } = useQuery<{ namespaces: NamespaceUsageItem[] }>({
    queryKey: queryKeys.cluster.namespaceUsage(),
    queryFn: async () => {
      const response = await fetch("/api/cluster/namespace-usage");
      if (!response.ok) throw new Error(`Failed to load namespace usage: ${response.status}`);
      return response.json() as Promise<{ namespaces: NamespaceUsageItem[] }>;
    },
    refetchInterval: 30_000,
  });

  const items = data?.namespaces ?? [];

  return (
    <div className={cn("rounded-xl border border-white/10 bg-white/5 p-4", className)}>
      <h3 className="text-sm font-semibold text-white mb-4">Namespace Usage</h3>
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-10 rounded-lg bg-white/5 animate-pulse" />)}
        </div>
      ) : error ? (
        <p className="text-xs text-red-400">Failed to load namespace data</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-white/40">No namespace data available</p>
      ) : (
        <div className="space-y-4">
          {items.map(item => (
            <div key={item.namespace}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-white/80">{item.namespace}</span>
                <span className="text-xs text-white/40">{item.podCount}/{item.podLimit} pods</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <div className="flex justify-between text-[10px] text-white/30 mb-0.5">
                    <span>CPU</span><span>{item.cpuUsed}m/{item.cpuLimit}m</span>
                  </div>
                  <ResourceBar value={item.cpuUsed} max={item.cpuLimit} valueFormatter={(value, max) => `${value}m/${max}m`} />
                </div>
                <div>
                  <div className="flex justify-between text-[10px] text-white/30 mb-0.5">
                    <span>MEM</span><span>{item.memUsed}Mi/{item.memLimit}Mi</span>
                  </div>
                  <ResourceBar value={item.memUsed} max={item.memLimit} valueFormatter={(value, max) => `${value}Mi/${max}Mi`} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

