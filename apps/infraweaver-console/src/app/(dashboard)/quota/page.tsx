"use client";

import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { DashboardPanel, DashboardStatCard, FilterSelect, PageScaffold, SearchInput } from "@/components/ui";
import { useApiQuery } from "@/hooks";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import type { ClusterQuotaResponse, NamespaceQuota } from "@/types";

const page = requirePageConfig("/quota");

const CRITICAL_THRESHOLD = 90;
const WARNING_THRESHOLD = 70;

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
  if (percentage >= CRITICAL_THRESHOLD) return "bg-red-500";
  if (percentage >= WARNING_THRESHOLD) return "bg-yellow-500";
  return "bg-indigo-500";
}

interface QuotaRow {
  resourceKey: string;
  used: string;
  hard: string;
  percentage: number;
}

interface QuotaView {
  quota: NamespaceQuota;
  rows: QuotaRow[];
  maxPercentage: number;
}

function toView(quota: NamespaceQuota): QuotaView {
  const rows = Object.keys(quota.hard)
    .map((resourceKey) => {
      const used = quota.used[resourceKey] ?? "0";
      const hard = quota.hard[resourceKey];
      return { resourceKey, used, hard, percentage: percentageUsed(used, hard) };
    })
    .sort((a, b) => b.percentage - a.percentage);
  const maxPercentage = rows.reduce((peak, row) => Math.max(peak, row.percentage), 0);
  return { quota, rows, maxPercentage };
}

function QuotaCard({ view }: { view: QuotaView }) {
  const { quota, rows, maxPercentage } = view;
  return (
    <DashboardPanel
      title={quota.namespace}
      description={quota.name}
      className="bg-slate-100 dark:bg-slate-900/60 backdrop-blur-sm"
      contentClassName="space-y-3"
      actions={
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
            maxPercentage >= CRITICAL_THRESHOLD
              ? "border-red-500/30 bg-red-500/10 text-red-500 dark:text-red-300"
              : maxPercentage >= WARNING_THRESHOLD
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-300"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
          }`}
        >
          {maxPercentage}% peak
        </span>
      }
    >
      {rows.map((row) => (
        <div key={row.resourceKey}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="text-slate-500 dark:text-slate-400">{row.resourceKey}</span>
            <span className="text-slate-700 dark:text-slate-300">{row.used} / {row.hard}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-white/10">
            <div className={`h-full rounded-full transition-all ${barColor(row.percentage)}`} style={{ width: `${row.percentage}%` }} />
          </div>
          <div className="mt-0.5 text-right text-[10px] text-slate-500">{row.percentage}%</div>
        </div>
      ))}
    </DashboardPanel>
  );
}

export default function QuotaPage() {
  const { data, isLoading, isError } = useApiQuery<ClusterQuotaResponse>({
    queryKey: queryKeys.cluster.quota(),
    path: page.apiBase ?? "/api/cluster/quota",
    staleTime: queryStaleTimes.short,
  });
  const quotas = useMemo(() => data?.quotas ?? [], [data?.quotas]);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"utilization" | "namespace">("utilization");

  const views = useMemo(() => quotas.map(toView), [quotas]);

  const summary = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let healthy = 0;
    for (const view of views) {
      if (view.maxPercentage >= CRITICAL_THRESHOLD) critical += 1;
      else if (view.maxPercentage >= WARNING_THRESHOLD) warning += 1;
      else healthy += 1;
    }
    return { critical, warning, healthy };
  }, [views]);

  const visibleViews = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = query
      ? views.filter((view) => view.quota.namespace.toLowerCase().includes(query) || view.quota.name.toLowerCase().includes(query))
      : views;
    return [...filtered].sort((a, b) =>
      sortBy === "utilization"
        ? b.maxPercentage - a.maxPercentage
        : a.quota.namespace.localeCompare(b.quota.namespace),
    );
  }, [views, search, sortBy]);

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={isLoading}
      isEmpty={!isLoading && !isError && quotas.length === 0}
      isError={isError}
      emptyState={{
        icon: page.icon,
        title: "No resource quotas found",
        description: "Create a ResourceQuota to start tracking per-namespace limits and usage.",
      }}
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <DashboardStatCard label="Near limit (≥90%)" value={summary.critical} tone={summary.critical > 0 ? "danger" : "neutral"} description="Namespaces at risk of hitting their ceiling" />
          <DashboardStatCard label="Approaching (70–90%)" value={summary.warning} tone={summary.warning > 0 ? "warning" : "neutral"} description="Watch for headroom before the next scale-up" />
          <DashboardStatCard label="Healthy (<70%)" value={summary.healthy} tone="success" description="Comfortable headroom remaining" />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={setSearch} placeholder="Search namespaces…" className="flex-1" />
          <FilterSelect
            label="Sort namespaces"
            value={sortBy}
            onChange={(value) => setSortBy(value as typeof sortBy)}
            options={[
              { value: "utilization", label: "Highest utilization" },
              { value: "namespace", label: "Namespace (A–Z)" },
            ]}
          />
        </div>

        {visibleViews.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No namespaces match your search.</p>
        ) : (
          <div className="space-y-4">
            {visibleViews.map((view) => (
              <QuotaCard key={`${view.quota.namespace}/${view.quota.name}`} view={view} />
            ))}
          </div>
        )}
      </motion.div>
    </PageScaffold>
  );
}
