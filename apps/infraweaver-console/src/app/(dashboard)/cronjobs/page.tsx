"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Play, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
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
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "failing" | "suspended" | "active">("all");
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery<CronJobsResponse>({
    queryKey: ["cronjobs"],
    queryFn: async () => {
      const response = await fetch("/api/cronjobs", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch cronjobs");
      return response.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

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

  async function handleTrigger(cronjob: CronJob) {
    setTriggeringId(cronjob.id);
    try {
      const response = await fetch("/api/cluster/trigger-cronjob", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: cronjob.namespace, name: cronjob.name }),
      });
      const payload = await response.json() as { ok?: boolean; jobName?: string; simulated?: boolean; error?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Failed to trigger CronJob");
      toast.success(payload.simulated ? `Simulated run: ${payload.jobName}` : `Started ${payload.jobName}`);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger CronJob");
    } finally {
      setTriggeringId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Calendar}
        title="CronJobs"
        subtitle="Scheduled workloads with next run prediction and one-click manual trigger"
        badge={data?.live === false ? "mock" : "live"}
        actions={
          <button
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </button>
        }
      />

      {data?.live === false ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Live CronJob data was unavailable, so the console is showing safe fallback schedule data.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">CronJobs</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.summary.total ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">Active</p>
          <p className="mt-2 text-3xl font-semibold text-emerald-300">{data?.summary.active ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-yellow-100/80">Suspended</p>
          <p className="mt-2 text-3xl font-semibold text-yellow-200">{data?.summary.suspended ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-red-100/80">Failing</p>
          <p className="mt-2 text-3xl font-semibold text-red-300">{data?.summary.failing ?? 0}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name, namespace, image, or cron schedule…"
              className="w-full rounded-xl border border-white/10 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-500/50"
            />
          </div>
          <select
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
          >
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="failing">Failing</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-64 rounded-2xl bg-white/5 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 py-16 text-center text-sm text-slate-500">
          No CronJobs matched the current filters.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((cronjob) => (
            <div key={cronjob.id} className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-white">{cronjob.name}</h2>
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
                  <p className="mt-1 text-sm text-slate-400">{cronjob.namespace} · {cronjob.concurrencyPolicy ?? "Allow"}</p>
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
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Schedule</p>
                  <p className="mt-2 font-mono text-sm text-white">{cronjob.schedule || "Unknown"}</p>
                  <p className="mt-1 text-xs text-slate-500">Image {cronjob.image || "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Next run</p>
                  <p className="mt-2 text-sm text-white">{formatTime(cronjob.nextRun)}</p>
                  <p className="mt-1 text-xs text-slate-500">Last scheduled {formatTime(cronjob.lastSchedule)}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last success</p>
                  <p className="mt-2 text-sm text-white">{formatTime(cronjob.lastSuccess)}</p>
                  <p className="mt-1 text-xs text-slate-500">{cronjob.lastSuccess ? timeAgo(cronjob.lastSuccess) : "No successful jobs yet"}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Last failure</p>
                  <p className="mt-2 text-sm text-white">{formatTime(cronjob.lastFailure)}</p>
                  <p className="mt-1 text-xs text-slate-500">{cronjob.lastFailure ? timeAgo(cronjob.lastFailure) : "No recorded failures"}</p>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Recent jobs</p>
                {cronjob.recentJobs.length === 0 ? (
                  <p className="mt-2 text-sm text-slate-500">No recent jobs recorded.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {cronjob.recentJobs.map((job) => (
                      <div key={job.name} className="rounded-xl border border-white/10 bg-slate-900/70 px-3 py-2 text-xs text-slate-300">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "h-2 w-2 rounded-full",
                            job.status === "succeeded" ? "bg-emerald-400" : job.status === "failed" ? "bg-red-400" : job.status === "running" ? "bg-indigo-400" : "bg-slate-500"
                          )} />
                          <span className="font-medium text-white">{job.name}</span>
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
    </div>
  );
}
