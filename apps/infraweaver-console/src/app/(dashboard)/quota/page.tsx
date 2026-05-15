"use client";

import { motion } from "framer-motion";
import { DashboardPanel, PageScaffold } from "@/components/ui";
import { useApiQuery } from "@/hooks";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import type { ClusterQuotaResponse, NamespaceQuota } from "@/types";

const page = requirePageConfig("/quota");

function parseValue(value: string): number {
  if (!value) return 0;
  if (value.endsWith("m")) return parseFloat(value) / 1000;
  if (value.endsWith("Ki")) return parseFloat(value) / (1024 * 1024);
  if (value.endsWith("Mi")) return parseFloat(value) / 1024;
  if (value.endsWith("Gi")) return parseFloat(value);
  return parseFloat(value);
}

function percentageUsed(used: string, hard: string): number {
  const usedValue = parseValue(used);
  const hardValue = parseValue(hard);
  if (hardValue === 0) return 0;
  return Math.min(100, Math.round((usedValue / hardValue) * 100));
}

function barColor(percentage: number) {
  if (percentage >= 90) return "bg-red-500";
  if (percentage >= 70) return "bg-yellow-500";
  return "bg-indigo-500";
}

function QuotaCard({ quota }: { quota: NamespaceQuota }) {
  return (
    <DashboardPanel title={quota.namespace} description={quota.name} className="bg-slate-900/60 backdrop-blur-sm" contentClassName="space-y-3">
      {Object.keys(quota.hard).map((resourceKey) => {
        const used = quota.used[resourceKey] ?? "0";
        const hard = quota.hard[resourceKey];
        const percentage = percentageUsed(used, hard);

        return (
          <div key={resourceKey}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-slate-400">{resourceKey}</span>
              <span className="text-slate-300">{used} / {hard}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full rounded-full transition-all ${barColor(percentage)}`} style={{ width: `${percentage}%` }} />
            </div>
            <div className="mt-0.5 text-right text-[10px] text-slate-500">{percentage}%</div>
          </div>
        );
      })}
    </DashboardPanel>
  );
}

export default function QuotaPage() {
  const { data, isLoading } = useApiQuery<ClusterQuotaResponse>({
    queryKey: queryKeys.cluster.quota(),
    path: page.apiBase ?? "/api/cluster/quota",
    staleTime: queryStaleTimes.short,
  });
  const quotas = data?.quotas ?? [];

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={isLoading}
      isEmpty={!isLoading && quotas.length === 0}
      emptyState={{
        icon: page.icon,
        title: "No resource quotas found",
        description: "Create a ResourceQuota to start tracking per-namespace limits and usage.",
      }}
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
        {quotas.map((quota) => (
          <QuotaCard key={`${quota.namespace}/${quota.name}`} quota={quota} />
        ))}
      </motion.div>
    </PageScaffold>
  );
}
