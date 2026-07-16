"use client";

import { useMemo, useState } from "react";
import { Calendar, Play } from "lucide-react";
import { DashboardStatCard, EmptyState, FilterSelect, KubeOfflineBanner, PageScaffold, RefreshButton, SearchInput } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useConfirm } from "@/hooks/use-confirm";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";

interface CronJobRun {
  name: string;
  status: "running" | "succeeded" | "failed" | "unknown";
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
}

interface CronJob {
  id: string;
  namespace: string;
  name: string;
  schedule: string;
  suspended: boolean;
  active: number;
  image: string;
  concurrencyPolicy: string | null;
  lastSchedule: string | null;
  nextRun: string | null;
  lastSuccess: string | null;
  lastFailure: string | null;
  failing: boolean;
  recentJobs: CronJobRun[];
}

interface CronJobsResponse {
  cronjobs: CronJob[];
  live: boolean;
  summary: { total: number; active: number; suspended: number; failing: number };
}

function formatTime(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function CronJobsPage() {
  const { can } = useRBAC();
  const { confirm, confirmDialog } = useConfirm();
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "failing" | "suspended" | "active">("all");

  const { data, isLoading, isFetching, refetch } = useApiQuery<CronJobsResponse>({
    queryKey: ["cronjobs"],
    path: "/api/cluster/cronjobs",
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const triggerMutation = useApiMutation<{ ok?: boolean; jobName?: string; simulated?: boolean }, CronJob>({
    path: "/api/cluster/trigger-cronjob",
    request: (cronjob) => ({ json: { namespace: cronjob.namespace, name: cronjob.name } }),
    invalidateQueryKeys: [["cronjobs"]],
    successMessage: (payload) => payload.simulated ? `Simulated run: ${payload.jobName}` : `Started ${payload.jobName}`,
  });
  const triggeringId = triggerMutation.isPending ? triggerMutation.variables?.id ?? null : null;

  const handleTrigger = async (cronjob: CronJob) => {
    const confirmed = await confirm({
      title: `Run "${cronjob.name}" now?`,
      description: `This launches a new job in ${cronjob.namespace} immediately, outside its normal schedule (${cronjob.schedule || "unknown"}).`,
      confirmText: "Run now",
      danger: true,
    });
    if (confirmed) triggerMutation.mutate(cronjob);
  };

  const cronjobs = useMemo(() => data?.cronjobs ?? [], [data?.cronjobs]);
  const namespaces = useMemo(() => Array.from(new Set(cronjobs.map((cronjob) => cronjob.namespace))).sort(), [cronjobs]);
  const filtered = useMemo(() => cronjobs.filter((cronjob) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query
      || cronjob.name.toLowerCase().includes(query)
      || cronjob.namespace.toLowerCase().includes(query)
      || cronjob.schedule.toLowerCase().includes(query)
      || cronjob.image.toLowerCase().includes(query);
    const matchesNamespace = namespaceFilter === "all" || cronjob.namespace === namespaceFilter;
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "failing" && cronjob.failing)
      || (statusFilter === "suspended" && cronjob.suspended)
      || (statusFilter === "active" && !cronjob.suspended);
    return matchesSearch && matchesNamespace && matchesStatus;
  }), [cronjobs, namespaceFilter, search, statusFilter]);

  const canTrigger = can("cluster:admin");

  return (
    <PageScaffold
      icon={Calendar}
      title="CronJobs"
      subtitle="Scheduled workloads with next run prediction and one-click manual trigger"
      badge={data?.live === false ? "offline" : "live"}
      actions={<RefreshButton onClick={() => void refetch()} refreshing={isFetching} />}
      loading={isLoading}
      bodyClassName="space-y-6"
    >
      <KubeOfflineBanner show={data?.live === false} resource="CronJob data" />

      <div className="grid gap-4 md:grid-cols-4">
        <DashboardStatCard label="CronJobs" value={data?.summary.total ?? 0} />
        <DashboardStatCard label="Active" value={data?.summary.active ?? 0} tone="success" />
        <DashboardStatCard label="Suspended" value={data?.summary.suspended ?? 0} tone="warning" />
        <DashboardStatCard label="Failing" value={data?.summary.failing ?? 0} tone="danger" />
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search by name, namespace, image, or cron schedule…"
            className="flex-1"
          />
          <FilterSelect
            label="Filter by namespace"
            value={namespaceFilter}
            onChange={setNamespaceFilter}
            options={[{ value: "all", label: "All namespaces" }, ...namespaces]}
          />
          <FilterSelect
            label="Filter by state"
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as typeof statusFilter)}
            options={[
              { value: "all", label: "All states" },
              { value: "active", label: "Active" },
              { value: "suspended", label: "Suspended" },
              { value: "failing", label: "Failing" },
            ]}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Calendar} title="No CronJobs matched the current filters." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((cronjob) => (
            <div key={cronjob.id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{cronjob.name}</h2>
                    <span className={cn(
                      "rounded-full border px-2.5 py-1 text-xs",
                      cronjob.suspended
                        ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-200"
                        : cronjob.failing
                          ? "border-red-500/30 bg-red-500/10 text-red-200"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    )}>
                      {cronjob.suspended ? "Suspended" : cronjob.failing ? "Failing" : "Healthy"}
                    </span>
                    {cronjob.active > 0 ? <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs text-indigo-200">{cronjob.active} running</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{cronjob.namespace} · {cronjob.concurrencyPolicy ?? "Allow"}</p>
                </div>
                {canTrigger ? (
                  <button
                    onClick={() => void handleTrigger(cronjob)}
                    disabled={triggeringId === cronjob.id}
                    className="inline-flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play className="h-4 w-4" />
                    {triggeringId === cronjob.id ? "Starting…" : "Run now"}
                  </button>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Schedule</p>
                  <p className="mt-2 font-mono text-sm text-gray-900 dark:text-white">{cronjob.schedule || "Unknown"}</p>
                  <p className="mt-1 text-xs text-slate-500">Image {cronjob.image || "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Next run</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{formatTime(cronjob.nextRun)}</p>
                  <p className="mt-1 text-xs text-slate-500">Last scheduled {formatTime(cronjob.lastSchedule)}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last success</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{formatTime(cronjob.lastSuccess)}</p>
                  <p className="mt-1 text-xs text-slate-500">{cronjob.lastSuccess ? timeAgo(cronjob.lastSuccess) : "No successful jobs yet"}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last failure</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{formatTime(cronjob.lastFailure)}</p>
                  <p className="mt-1 text-xs text-slate-500">{cronjob.lastFailure ? timeAgo(cronjob.lastFailure) : "No recorded failures"}</p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Recent jobs</p>
                {cronjob.recentJobs.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No recent jobs recorded.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {cronjob.recentJobs.map((job) => (
                      <div key={job.name} className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 px-3 py-2 text-xs text-slate-700 dark:text-slate-300">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "h-2 w-2 rounded-full",
                            job.status === "succeeded" ? "bg-emerald-400" : job.status === "failed" ? "bg-red-400" : job.status === "running" ? "bg-indigo-400" : "bg-slate-500"
                          )} />
                          <span className="font-medium text-gray-900 dark:text-white">{job.name}</span>
                        </div>
                        <p className="mt-1 text-slate-500">{job.startedAt ? formatTime(job.startedAt) : "Pending"}</p>
                        <p className="text-slate-500">{job.durationSeconds !== null ? `${job.durationSeconds}s` : job.status}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {confirmDialog}
    </PageScaffold>
  );
}
