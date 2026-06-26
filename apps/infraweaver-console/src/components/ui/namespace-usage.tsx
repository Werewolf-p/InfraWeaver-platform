"use client";

import { memo } from "react";
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

// Stable module-level formatters — no closure, no re-creation per render.
function formatCpu(value: number, max: number): string {
  return `${value}m/${max}m`;
}

function formatMem(value: number, max: number): string {
  return `${value}Mi/${max}Mi`;
}

interface NamespaceRowProps {
  item: NamespaceUsageItem;
}

const NamespaceRow = memo(function NamespaceRow({ item }: NamespaceRowProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-700 dark:text-white/80">{item.namespace}</span>
        <span className="text-xs text-gray-400 dark:text-white/40">{item.podCount}/{item.podLimit} pods</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <div className="flex justify-between text-[10px] text-gray-400 dark:text-white/30 mb-0.5">
            <span>CPU</span><span>{item.cpuUsed}m/{item.cpuLimit}m</span>
          </div>
          <ResourceBar value={item.cpuUsed} max={item.cpuLimit} valueFormatter={formatCpu} />
        </div>
        <div>
          <div className="flex justify-between text-[10px] text-gray-400 dark:text-white/30 mb-0.5">
            <span>MEM</span><span>{item.memUsed}Mi/{item.memLimit}Mi</span>
          </div>
          <ResourceBar value={item.memUsed} max={item.memLimit} valueFormatter={formatMem} />
        </div>
      </div>
    </div>
  );
});

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
    <div className={cn("rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4", className)}>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">Namespace Usage</h3>
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="h-10 rounded-lg bg-gray-100 dark:bg-white/5 animate-pulse" />)}
        </div>
      ) : error ? (
        <p className="text-xs text-red-400">Failed to load namespace data</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-white/40">No namespace data available</p>
      ) : (
        <div className="space-y-4">
          {items.map(item => (
            <NamespaceRow key={item.namespace} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

