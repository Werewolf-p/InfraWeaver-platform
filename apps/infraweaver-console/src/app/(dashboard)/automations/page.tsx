"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Activity, GitBranch, Play, ShieldAlert, Sparkles, Workflow } from "lucide-react";
import { toast } from "@/lib/notify";
import { DataCard } from "@/components/ui/data-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePermissions } from "@/hooks/use-permissions";
import { timeAgo } from "@/lib/utils";

interface ClusterAutomation {
  id: string;
  title: string;
  description: string;
  namespace: string;
  cronjob: string;
  file: string;
  category: string;
  live: boolean;
  canTrigger: boolean;
  schedule: string | null;
  suspended: boolean;
  activeRuns: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  nextRun: string | null;
  failing: boolean;
  recentRuns: Array<{ name: string; status: string; completedAt: string | null; startedAt: string | null }>;
}

interface WorkflowAutomation {
  id: string;
  title: string;
  schedule: string;
  file: string;
  description: string;
}

interface AutomationPayload {
  generatedAt: string;
  liveCronData: boolean;
  canTrigger: boolean;
  clusterAutomations: ClusterAutomation[];
  workflowAutomations: WorkflowAutomation[];
}

export default function AutomationsPage() {
  const { canAny } = usePermissions();
  const canView = canAny(["infra:read", "cluster:read"]);
  const queryClient = useQueryClient();

  const automationQuery = useQuery<AutomationPayload>({
    queryKey: ["automation-overview"],
    queryFn: async () => {
      const response = await fetch("/api/automation/overview", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load automation overview");
      return response.json();
    },
    enabled: canView,
    refetchInterval: 30_000,
  });

  const triggerMutation = useMutation({
    mutationFn: async ({ namespace, name }: { namespace: string; name: string }) => {
      const response = await fetch("/api/cluster/trigger-cronjob", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name }),
      });
      const payload = await response.json() as { ok?: boolean; error?: string; simulated?: boolean; jobName?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to trigger automation");
      return payload;
    },
    onSuccess: (payload, variables) => {
      toast.success(payload.simulated ? `Simulated ${variables.name}` : `Triggered ${variables.name}`);
      void queryClient.invalidateQueries({ queryKey: ["automation-overview"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to trigger automation");
    },
  });

  if (!canView) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Automation overview is restricted"
        description="You need infra or cluster read access to inspect automation coverage."
      />
    );
  }

  const data = automationQuery.data;
  const clusterAutomations = data?.clusterAutomations ?? [];
  const workflowAutomations = data?.workflowAutomations ?? [];
  const unhealthy = clusterAutomations.filter((item) => item.failing || !item.live).length;
  const triggerable = clusterAutomations.filter((item) => item.canTrigger).length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={Workflow}
        title="Automation Hub"
        description="Track the self-healing jobs and GitHub automations that keep the homelab moving without manual babysitting."
        badge={`${clusterAutomations.length + workflowAutomations.length} automations`}
      />

      <div className="grid gap-3 md:grid-cols-4">
        <DataCard title="Cluster automations" value={clusterAutomations.length} subtitle={data?.liveCronData ? "Live CronJob data" : "Fallback inventory"} />
        <DataCard title="Workflow automations" value={workflowAutomations.length} subtitle="GitHub Actions automation" />
        <DataCard title="Need attention" value={unhealthy} subtitle="Missing or failing automation" trend={unhealthy > 0 ? "down" : "up"} />
        <DataCard title="Triggerable" value={triggerable} subtitle="Manual fire drills available" />
      </div>

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
          <Sparkles className="h-4 w-4 text-indigo-300" />
          Cluster automations
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {clusterAutomations.map((automation) => {
            const status = !automation.live ? "unknown" : automation.failing ? "degraded" : automation.suspended ? "warning" : "healthy";
            const label = !automation.live ? "Repo only" : automation.failing ? "Needs attention" : automation.suspended ? "Suspended" : "Healthy";
            return (
              <div key={automation.id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-5 backdrop-blur-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold text-gray-900 dark:text-white">{automation.title}</h2>
                      <StatusBadge status={status} label={label} size="sm" />
                    </div>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{automation.description}</p>
                  </div>
                  <span className="rounded-full border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-2.5 py-1 text-[11px] uppercase tracking-wide text-slate-700 dark:text-slate-300">
                    {automation.category}
                  </span>
                </div>

                <dl className="mt-4 grid gap-3 text-xs text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">CronJob</dt>
                    <dd className="font-mono text-slate-700 dark:text-slate-300">{automation.namespace}/{automation.cronjob}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Schedule</dt>
                    <dd className="font-mono text-slate-700 dark:text-slate-300">{automation.schedule ?? "Waiting for live cluster data"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Last success</dt>
                    <dd className="text-slate-700 dark:text-slate-300">{automation.lastSuccess ? timeAgo(automation.lastSuccess) : "Never recorded"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Next run</dt>
                    <dd className="text-slate-700 dark:text-slate-300">{automation.nextRun ? timeAgo(automation.nextRun) : "Unknown"}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Manifest</dt>
                    <dd className="font-mono text-[11px] text-slate-700 dark:text-slate-300">{automation.file}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Active runs</dt>
                    <dd className="text-slate-700 dark:text-slate-300">{automation.activeRuns}</dd>
                  </div>
                </dl>

                {automation.recentRuns.length > 0 ? (
                  <div className="mt-4 rounded-xl border border-gray-200 dark:border-white/10 bg-black/20 p-3">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Recent runs</p>
                    <div className="space-y-2 text-xs text-slate-500 dark:text-slate-400">
                      {automation.recentRuns.map((run) => (
                        <div key={run.name} className="flex items-center justify-between gap-3">
                          <span className="font-mono text-slate-700 dark:text-slate-300">{run.name}</span>
                          <span>{run.completedAt ? timeAgo(run.completedAt) : run.startedAt ? timeAgo(run.startedAt) : run.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 flex items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">Updated {data?.generatedAt ? timeAgo(data.generatedAt) : "just now"}</p>
                  <button
                    type="button"
                    onClick={() => triggerMutation.mutate({ namespace: automation.namespace, name: automation.cronjob })}
                    disabled={!data?.canTrigger || triggerMutation.isPending}
                    className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Play className="h-4 w-4" />
                    Run now
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
          <GitBranch className="h-4 w-4 text-emerald-300" />
          GitHub workflow automations
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {workflowAutomations.map((automation) => (
            <div key={automation.id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-5 backdrop-blur-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">{automation.title}</h2>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{automation.description}</p>
                </div>
                <StatusBadge status="healthy" label="GitHub Actions" size="sm" />
              </div>
              <dl className="mt-4 grid gap-3 text-xs text-slate-500 dark:text-slate-400">
                <div>
                  <dt className="text-slate-500">Schedule</dt>
                  <dd className="text-slate-700 dark:text-slate-300">{automation.schedule}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Workflow file</dt>
                  <dd className="font-mono text-[11px] text-slate-700 dark:text-slate-300">{automation.file}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </section>

      {automationQuery.isLoading ? (
        <div className="flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
          <Activity className="h-4 w-4 animate-pulse" />
          Refreshing automation status…
        </div>
      ) : null}
    </motion.div>
  );
}
