"use client";

import { motion } from "framer-motion";
import { TrendingDown } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { DashboardPanel, DashboardStatCard, PageScaffold, ResourceBar, ResourceTable, type Column } from "@/components/ui";
import { useApiQuery } from "@/hooks";
import { queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import { COST_RATE_NOTE } from "@/lib/finops/cost-model";
import type { CostAttribution } from "@/lib/finops/cost-attribution";
import type { ClusterCostResponse, NamespaceCost } from "@/types";

const RECLAIMABLE_TOP_N = 8;

const page = requirePageConfig("/cost");

// Recharts inline styles can't take Tailwind classes, so drive them off the
// same CSS variables the rest of the console themes with — keeps charts legible
// in both light and dark mode instead of hardcoding dark-only literals.
const CHART_GRID_STROKE = "rgb(var(--color-border))";
const CHART_AXIS_FILL = "rgb(var(--color-text-tertiary))";
const CHART_TOOLTIP_STYLE = {
  background: "rgb(var(--color-surface-raised))",
  border: "1px solid rgb(var(--color-border))",
  borderRadius: 8,
  color: "rgb(var(--color-text-primary))",
} as const;
const CHART_TOOLTIP_LABEL_STYLE = { color: "rgb(var(--color-text-secondary))" } as const;

// A cost row is a namespace's request-based cost joined with its actual-usage
// attribution (utilization + reclaimable dollars) when that data is available.
interface CostRow extends NamespaceCost {
  utilizationPct?: number;
  usedUsd?: number;
  requestedUsd?: number;
  reclaimableUsd?: number;
}

// Low utilization is the *bad* case here (money reserved but never used), so the
// bar tone is inverted vs. the usual "high = hot = red" resource meter.
function utilizationTone(pct: number): "emerald" | "amber" | "red" {
  if (pct >= 70) return "emerald";
  if (pct >= 40) return "amber";
  return "red";
}

const columns: Column<CostRow>[] = [
  { key: "namespace", label: "Namespace", sortable: true },
  {
    key: "utilizationPct",
    label: "Utilization",
    sortable: true,
    className: "min-w-[160px]",
    render: (row) =>
      row.utilizationPct == null ? (
        <span className="text-slate-400 dark:text-slate-500">—</span>
      ) : (
        <ResourceBar
          value={row.usedUsd ?? 0}
          max={row.requestedUsd ?? row.monthlyCostUsd}
          tone={utilizationTone(row.utilizationPct)}
          valueFormatter={() => `${row.utilizationPct}% used`}
        />
      ),
  },
  {
    key: "reclaimableUsd",
    label: "Reclaimable / mo",
    sortable: true,
    className: "text-right",
    render: (row) =>
      row.reclaimableUsd == null ? (
        <span className="text-slate-400 dark:text-slate-500">—</span>
      ) : row.reclaimableUsd > 0 ? (
        <span className="font-semibold text-amber-600 dark:text-amber-300">${row.reclaimableUsd.toFixed(2)}</span>
      ) : (
        <span className="text-emerald-600 dark:text-emerald-400">$0.00</span>
      ),
  },
  {
    key: "monthlyCostUsd",
    label: "Monthly Cost",
    sortable: true,
    className: "text-right",
    render: (row) => <span className="font-semibold text-indigo-600 dark:text-indigo-300">${row.monthlyCostUsd.toFixed(2)}</span>,
  },
];

export default function CostPage() {
  const { data, isLoading, isError } = useApiQuery<ClusterCostResponse>({
    queryKey: queryKeys.cluster.cost(),
    path: page.apiBase ?? "/api/cluster/cost",
    staleTime: queryStaleTimes.short,
  });

  const { data: attribution } = useApiQuery<CostAttribution & { live: boolean }>({
    queryKey: queryKeys.cluster.costAttribution(),
    path: "/api/cluster/cost-attribution",
    staleTime: queryStaleTimes.short,
  });

  const namespaces = data?.namespaces ?? [];
  const totalMonthlyCost = data?.totalMonthlyCost ?? 0;
  const chartData = namespaces.map((namespaceCost) => ({
    name: namespaceCost.namespace,
    cost: namespaceCost.monthlyCostUsd,
  }));

  const reclaimableTotal = attribution?.totals.reclaimableUsd ?? 0;
  const reclaimablePctOfSpend = totalMonthlyCost > 0 ? Math.round((reclaimableTotal / totalMonthlyCost) * 100) : 0;
  const reclaimableChart = (attribution?.namespaces ?? [])
    .filter((ns) => ns.reclaimableUsd > 0)
    .slice(0, RECLAIMABLE_TOP_N)
    .map((ns) => ({ name: ns.namespace, used: ns.usedUsd, reclaimable: ns.reclaimableUsd }));

  // Merge attribution into the request-based rows and rank by wasted dollars, so
  // the breakdown reads as a prioritized savings worklist instead of a passive
  // estimate. Falls back to cost order until attribution loads.
  const attributionByNs = new Map((attribution?.namespaces ?? []).map((ns) => [ns.namespace, ns]));
  const rows: CostRow[] = namespaces
    .map((ns) => {
      const attr = attributionByNs.get(ns.namespace);
      return {
        ...ns,
        utilizationPct: attr?.utilizationPct,
        usedUsd: attr?.usedUsd,
        requestedUsd: attr?.requestedUsd,
        reclaimableUsd: attr?.reclaimableUsd,
      };
    })
    .sort((a, b) => (b.reclaimableUsd ?? -1) - (a.reclaimableUsd ?? -1) || b.monthlyCostUsd - a.monthlyCostUsd);

  const biggestOffender = rows.find((row) => (row.reclaimableUsd ?? 0) > 0);

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={isLoading}
      isEmpty={!isLoading && !isError && namespaces.length === 0}
      isError={isError}
      emptyState={{
        icon: page.icon,
        title: "No namespace costs available",
        description: "Expose cluster requests or metrics to start estimating namespace costs.",
      }}
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DashboardStatCard
            label="Total monthly estimate"
            value={`$${totalMonthlyCost.toFixed(2)}`}
            icon={page.icon}
            tone="info"
            description={COST_RATE_NOTE}
          />
          <DashboardStatCard
            label="Reclaimable / month"
            value={`$${reclaimableTotal.toFixed(2)}`}
            icon={page.icon}
            tone={reclaimableTotal > 0 ? "warning" : "success"}
            description={
              reclaimableTotal > 0
                ? `${reclaimablePctOfSpend}% of total spend — capacity actual usage never touches`
                : "Requested capacity is well matched to actual usage"
            }
          />
        </div>

        {biggestOffender && biggestOffender.reclaimableUsd != null && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-200"
            role="status"
          >
            <TrendingDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              Biggest offender: <span className="font-semibold">{biggestOffender.namespace}</span> is wasting{" "}
              <span className="font-semibold">${biggestOffender.reclaimableUsd.toFixed(2)}/mo</span>
              {biggestOffender.utilizationPct != null ? ` at only ${biggestOffender.utilizationPct}% utilization` : ""} —
              trim its requests to recover the spend.
            </span>
          </motion.div>
        )}

        {reclaimableChart.length > 0 && (
          <DashboardPanel title="Reclaimable by Namespace" description="Used vs idle (reclaimable) monthly spend — trim requests to recover the amber portion.">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={reclaimableChart}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="name" tick={{ fill: CHART_AXIS_FILL, fontSize: 11 }} />
                <YAxis tick={{ fill: CHART_AXIS_FILL, fontSize: 11 }} tickFormatter={(value: number) => `$${value}`} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  formatter={(value, name) => [`$${Number(value).toFixed(2)}`, name === "used" ? "Used" : "Reclaimable"]}
                />
                <Bar dataKey="used" stackId="cost" fill="#6366f1" />
                <Bar dataKey="reclaimable" stackId="cost" fill="#eab308" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </DashboardPanel>
        )}

        <DashboardPanel title="Cost by Namespace" description="Estimated monthly cloud cost based on requested resources.">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="name" tick={{ fill: CHART_AXIS_FILL, fontSize: 11 }} />
              <YAxis tick={{ fill: CHART_AXIS_FILL, fontSize: 11 }} tickFormatter={(value: number) => `$${value}`} />
              <Tooltip
                contentStyle={CHART_TOOLTIP_STYLE}
                labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                formatter={(value) => [`$${Number(value).toFixed(2)}`, "Monthly Cost"]}
              />
              <Bar dataKey="cost" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </DashboardPanel>

        <DashboardPanel title="Namespace Breakdown" description="Ranked by reclaimable spend — the biggest wasters sit at the top.">
          <ResourceTable
            columns={columns}
            data={rows}
            getRowKey={(row) => row.namespace}
            mobileCardRender={(row) => (
              <div className="space-y-2 text-sm">
                <div className="font-medium text-gray-900 dark:text-white">{row.namespace}</div>
                <div className="text-slate-500 dark:text-slate-400">CPU: {row.cpuMillicores}m · Memory: {row.memoryMiB} MiB</div>
                {row.utilizationPct != null && (
                  <ResourceBar
                    value={row.usedUsd ?? 0}
                    max={row.requestedUsd ?? row.monthlyCostUsd}
                    tone={utilizationTone(row.utilizationPct)}
                    valueFormatter={() => `${row.utilizationPct}% used`}
                  />
                )}
                <div className="flex items-center justify-between">
                  <span className="text-indigo-600 dark:text-indigo-300">${row.monthlyCostUsd.toFixed(2)} / month</span>
                  {row.reclaimableUsd != null && row.reclaimableUsd > 0 && (
                    <span className="font-semibold text-amber-600 dark:text-amber-300">${row.reclaimableUsd.toFixed(2)} reclaimable</span>
                  )}
                </div>
              </div>
            )}
          />
        </DashboardPanel>
      </motion.div>
    </PageScaffold>
  );
}
