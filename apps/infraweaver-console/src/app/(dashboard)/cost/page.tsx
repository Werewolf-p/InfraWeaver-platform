"use client";

import { motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DashboardPanel, DashboardStatCard, PageScaffold, ResourceTable, type Column } from "@/components/ui";
import { useApiQuery } from "@/hooks";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import type { ClusterCostResponse, NamespaceCost } from "@/types";

const page = requirePageConfig("/cost");

const columns: Column<NamespaceCost>[] = [
  { key: "namespace", label: "Namespace", sortable: true },
  { key: "cpuMillicores", label: "CPU (m)", sortable: true, className: "text-right" },
  { key: "memoryMiB", label: "Memory (MiB)", sortable: true, className: "text-right" },
  {
    key: "monthlyCostUsd",
    label: "Monthly Cost",
    sortable: true,
    className: "text-right",
    render: (row) => <span className="font-semibold text-indigo-300">${row.monthlyCostUsd.toFixed(2)}</span>,
  },
];

export default function CostPage() {
  const { data, isLoading } = useApiQuery<ClusterCostResponse>({
    queryKey: queryKeys.cluster.cost(),
    path: page.apiBase ?? "/api/cluster/cost",
    staleTime: queryStaleTimes.short,
  });

  const namespaces = data?.namespaces ?? [];
  const totalMonthlyCost = data?.totalMonthlyCost ?? 0;
  const chartData = namespaces.map((namespaceCost) => ({
    name: namespaceCost.namespace,
    cost: namespaceCost.monthlyCostUsd,
  }));

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={isLoading}
      isEmpty={!isLoading && namespaces.length === 0}
      emptyState={{
        icon: page.icon,
        title: "No namespace costs available",
        description: "Expose cluster requests or metrics to start estimating namespace costs.",
      }}
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
        <DashboardStatCard
          label="Total monthly estimate"
          value={`$${totalMonthlyCost.toFixed(2)}`}
          icon={page.icon}
          tone="info"
          description="CPU: $0.048/vCPU/hr · Memory: $0.006/GB/hr"
        />

        <DashboardPanel title="Cost by Namespace" description="Estimated monthly cloud cost based on requested resources.">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
              <XAxis dataKey="name" tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(value: number) => `$${value}`} />
              <Tooltip
                contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                formatter={(value) => [`$${Number(value).toFixed(2)}`, "Monthly Cost"]}
              />
              <Bar dataKey="cost" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </DashboardPanel>

        <DashboardPanel title="Namespace Breakdown" description="Sortable estimate summary for each namespace.">
          <ResourceTable
            columns={columns}
            data={namespaces}
            getRowKey={(row) => row.namespace}
            mobileCardRender={(row) => (
              <div className="space-y-1 text-sm">
                <div className="font-medium text-gray-900 dark:text-white">{row.namespace}</div>
                <div className="text-slate-500 dark:text-slate-400">CPU: {row.cpuMillicores}m</div>
                <div className="text-slate-500 dark:text-slate-400">Memory: {row.memoryMiB} MiB</div>
                <div className="text-indigo-300">${row.monthlyCostUsd.toFixed(2)} / month</div>
              </div>
            )}
          />
        </DashboardPanel>
      </motion.div>
    </PageScaffold>
  );
}
