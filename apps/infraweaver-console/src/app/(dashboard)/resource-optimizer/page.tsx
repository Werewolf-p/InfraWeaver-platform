"use client";

import { motion } from "framer-motion";
import { TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton, DashboardStatCard, PageScaffold, ResourceTable, type Column } from "@/components/ui";
import { useApiQuery } from "@/hooks/use-api-query";
import { formatQuantity } from "@/lib/k8s-quantity";
import { COST_RATE_NOTE } from "@/lib/finops/cost-model";
import type { RightsizingRec, RightsizingStatus } from "@/lib/finops/rightsizing";

interface RightsizingResponse {
  recommendations: RightsizingRec[];
  summary: {
    analyzed: number;
    overCount: number;
    underCount: number;
    optimalCount: number;
    noMetricsCount: number;
    totalMonthlyWasteUsd: number;
  };
  live: boolean;
}

const STATUS_STYLE: Record<RightsizingStatus, string> = {
  over: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  under: "bg-red-500/10 text-red-400 border-red-500/20",
  optimal: "bg-green-500/10 text-green-400 border-green-500/20",
  "no-metrics": "bg-slate-500/10 text-slate-400 border-slate-500/20",
};

const STATUS_LABEL: Record<RightsizingStatus, string> = {
  over: "over-provisioned",
  under: "under-provisioned",
  optimal: "optimal",
  "no-metrics": "no metrics",
};

function cpu(m: number): string {
  return m > 0 ? formatQuantity(m / 1000, "cpu") : "—";
}
function mem(mi: number): string {
  return mi > 0 ? formatQuantity(mi, "memory") : "—";
}

/** Ready-to-paste `resources` block seeding the recommended requests for one container. */
function recommendedResourcesYaml(row: RightsizingRec): string {
  return [
    `# ${row.namespace}/${row.pod} · container: ${row.container}`,
    `# rightsized requests from observed usage`,
    `resources:`,
    `  requests:`,
    `    cpu: ${row.recommendedCpuM}m`,
    `    memory: ${row.recommendedMemMi}Mi`,
  ].join("\n");
}

const columns: Column<RightsizingRec>[] = [
  {
    key: "pod",
    label: "Pod / Container",
    sortable: true,
    render: (row) => (
      <div>
        <p className="text-sm font-medium text-gray-900 dark:text-white">{row.pod}</p>
        <p className="text-xs text-slate-500">{row.container}</p>
      </div>
    ),
  },
  { key: "namespace", label: "Namespace", sortable: true },
  {
    key: "usageCpuM",
    label: "CPU req → use → rec",
    className: "font-mono text-xs",
    render: (row) => (
      <span>
        {cpu(row.requestCpuM)} → <span className="text-slate-400">{cpu(row.usageCpuM)}</span> → <span className="text-indigo-300">{cpu(row.recommendedCpuM)}</span>
      </span>
    ),
  },
  {
    key: "usageMemMi",
    label: "Mem req → use → rec",
    className: "font-mono text-xs",
    render: (row) => (
      <span>
        {mem(row.requestMemMi)} → <span className="text-slate-400">{mem(row.usageMemMi)}</span> → <span className="text-indigo-300">{mem(row.recommendedMemMi)}</span>
      </span>
    ),
  },
  {
    key: "monthlyWasteUsd",
    label: "Monthly waste",
    sortable: true,
    className: "text-right",
    render: (row) => (row.monthlyWasteUsd > 0 ? <span className="font-semibold text-yellow-300">${row.monthlyWasteUsd.toFixed(2)}</span> : <span className="text-slate-500">—</span>),
  },
  {
    key: "status",
    label: "Status",
    sortable: true,
    render: (row) => <span className={cn("rounded-full border px-2 py-0.5 text-xs", STATUS_STYLE[row.status])}>{STATUS_LABEL[row.status]}</span>,
  },
  {
    key: "apply",
    label: "Apply",
    className: "text-right",
    mobileHide: true,
    render: (row) =>
      row.status === "over" || row.status === "under" ? (
        <CopyButton text={recommendedResourcesYaml(row)} label="YAML" className="ml-auto" />
      ) : (
        <span className="text-slate-500">—</span>
      ),
  },
];

export default function ResourceOptimizerPage() {
  const { data, isLoading, isError } = useApiQuery<RightsizingResponse>({
    queryKey: ["cluster", "rightsizing"],
    path: "/api/cluster/rightsizing",
    staleTime: 60_000,
  });

  const { data: headroom } = useApiQuery<{
    nodes: Array<{ name: string; allocatableCpuM: number; allocatableMemMi: number; freeCpuM: number; freeMemMi: number }>;
    cluster: { freeCpuM: number; freeMemMi: number; allocatableCpuM: number; allocatableMemMi: number };
  }>({
    queryKey: ["cluster", "headroom"],
    path: "/api/cluster/headroom",
    staleTime: 60_000,
  });

  const recs = data?.recommendations ?? [];
  const summary = data?.summary;
  const nodes = headroom?.nodes ?? [];

  return (
    <PageScaffold
      icon={TrendingDown}
      title="Resource Optimizer"
      description="Right-size CPU and memory requests from actual usage — reclaim over-provisioned headroom, catch under-provisioned risk."
      loading={isLoading}
      isError={isError}
      isEmpty={!isLoading && !isError && recs.length === 0}
      emptyState={{
        icon: TrendingDown,
        title: "No rightsizing data",
        description: "metrics-server must be reachable to compare requests against actual usage.",
      }}
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <DashboardStatCard
            label="Reclaimable / month"
            value={`$${(summary?.totalMonthlyWasteUsd ?? 0).toFixed(2)}`}
            icon={TrendingDown}
            tone={summary && summary.totalMonthlyWasteUsd > 0 ? "warning" : "success"}
            description={COST_RATE_NOTE}
          />
          <DashboardStatCard label="Over-provisioned" value={summary?.overCount ?? 0} tone={summary && summary.overCount > 0 ? "warning" : "success"} description="Trim wasted headroom" />
          <DashboardStatCard label="Under-provisioned" value={summary?.underCount ?? 0} tone={summary && summary.underCount > 0 ? "danger" : "success"} description="Throttle / OOM risk" />
          <DashboardStatCard label="Containers analyzed" value={summary?.analyzed ?? 0} description={`${summary?.noMetricsCount ?? 0} without metrics`} />
        </div>

        <ResourceTable columns={columns} data={recs} getRowKey={(row) => `${row.namespace}/${row.pod}/${row.container}`} />

        {nodes.length > 0 && (
          <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
            <p className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
              Cluster headroom · {cpu(headroom?.cluster.freeCpuM ?? 0)} CPU · {mem(headroom?.cluster.freeMemMi ?? 0)} free
            </p>
            <div className="space-y-2">
              {nodes.map((node) => {
                const memPct = node.allocatableMemMi > 0 ? Math.round((node.freeMemMi / node.allocatableMemMi) * 100) : 0;
                return (
                  <div key={node.name} className="flex items-center gap-3 text-xs">
                    <span className="w-40 shrink-0 truncate font-mono text-slate-600 dark:text-slate-300">{node.name}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/10">
                      <div className="h-full rounded-full bg-emerald-500/60" style={{ width: `${memPct}%` }} />
                    </div>
                    <span className="w-32 shrink-0 text-right text-slate-500">{cpu(node.freeCpuM)} · {mem(node.freeMemMi)} free</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </motion.div>
    </PageScaffold>
  );
}
