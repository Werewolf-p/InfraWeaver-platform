"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { RefreshCw, RotateCcw, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { CommandBar } from "@/components/ui/command-bar";
import { CopyButton } from "@/components/ui/copy-button";
import { DataCard } from "@/components/ui/data-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResourceBar } from "@/components/ui/resource-bar";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { PodRowSkeleton } from "@/components/ui/skeleton-card";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { usePermissions } from "@/hooks/use-permissions";
import { usePods, type Pod } from "@/hooks/use-pods";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "sonner";

type PodStatusFilter = "all" | "running" | "pending" | "failed" | "crashloopbackoff";

const STATUS_FILTERS: Array<{ value: PodStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "crashloopbackoff", label: "CrashLoopBackOff" },
];

function normalizedStatus(status: string): PodStatusFilter | "unknown" {
  const value = status.toLowerCase();
  if (value.includes("crashloopbackoff") || value.includes("backoff")) return "crashloopbackoff";
  if (value.includes("running")) return "running";
  if (value.includes("pending") || value.includes("containercreating")) return "pending";
  if (value.includes("failed") || value.includes("error")) return "failed";
  return "unknown";
}

function restartColor(restarts: number) {
  if (restarts > 20) return "text-red-400";
  if (restarts > 5) return "text-amber-300";
  return "text-slate-300";
}

function PodMobileCard({
  pod,
  simpleMode,
  isAdmin,
  restartingPod,
  onRestart,
}: {
  pod: Pod;
  simpleMode: boolean;
  isAdmin: boolean;
  restartingPod: string | null;
  onRestart: (namespace: string, name: string) => void;
}) {
  const key = `${pod.namespace}/${pod.name}`;
  const restartCount = pod.restartCount ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <Link
              href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`}
              className="min-w-0 flex-1 truncate text-base font-semibold text-white transition hover:text-indigo-300"
            >
              {pod.name}
            </Link>
            <CopyButton text={pod.name} className="h-11 w-11 justify-center px-0" />
          </div>
          <p className="mt-1 text-sm text-slate-400">{pod.namespace}</p>
        </div>
        <StatusBadge status={pod.status} label={pod.status} size="sm" />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate-500">Age</dt>
          <dd className="mt-1 text-slate-200" title={pod.createdAt ? new Date(pod.createdAt).toLocaleString() : "Unknown age"}>
            {pod.createdAt ? timeAgo(pod.createdAt) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Restarts</dt>
          <dd className={cn("mt-1 font-medium", restartColor(restartCount))}>{restartCount}</dd>
        </div>
        {!simpleMode ? (
          <>
            <div>
              <dt className="text-slate-500">Node</dt>
              <dd className="mt-1 truncate text-slate-300">{pod.nodeName || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Containers</dt>
              <dd className="mt-1 text-slate-300">{Array.isArray(pod.containers) ? pod.containers.length : 0}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {!simpleMode && Array.isArray(pod.containers) && pod.containers.length > 0 ? (
        <p className="mt-3 text-sm text-slate-400">{pod.containers.join(", ")}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Link
          href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`}
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 hover:text-white"
        >
          View details
        </Link>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => onRestart(pod.namespace, pod.name)}
            disabled={restartingPod === key}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
          >
            <RotateCcw className={cn("h-4 w-4", restartingPod === key && "animate-spin")} />
            Restart
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function PodsPage() {
  const { isAdmin } = usePermissions();
  const [nsFilter, setNsFilter] = useLocalStorage<string>("pods-namespace-filter", "all");
  const [statusFilter, setStatusFilter] = useLocalStorage<PodStatusFilter>("pods-status-filter", "all");
  const [search, setSearch] = useLocalStorage("pods-search", "");
  const [restartingPod, setRestartingPod] = useState<string | null>(null);
  const debouncedSearch = useDebounce(search, 200);
  const { simpleMode, toggle } = useSimpleMode();
  const { data: pods = [], isLoading, refetch } = usePods();

  const filteredPods = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();

    return pods.filter((pod) =>
      (nsFilter === "all" || pod.namespace === nsFilter) &&
      (statusFilter === "all" || normalizedStatus(pod.status) === statusFilter) &&
      (!query || pod.name.toLowerCase().includes(query)),
    );
  }, [debouncedSearch, nsFilter, pods, statusFilter]);

  const namespaces = useMemo(() => ["all", ...new Set(pods.map((pod) => pod.namespace))], [pods]);
  const runningCount = pods.filter((pod) => normalizedStatus(pod.status) === "running").length;
  const unhealthyCount = pods.filter((pod) => {
    const status = normalizedStatus(pod.status);
    return status === "failed" || status === "crashloopbackoff";
  }).length;

  async function handleRestart(namespace: string, name: string) {
    setRestartingPod(`${namespace}/${name}`);
    try {
      const response = await fetch("/api/pods/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name }),
      });
      if (!response.ok) throw new Error("Failed to restart pod");
      toast.success(`Restarting ${name}`);
      await refetch();
    } catch {
      toast.error("Failed to restart pod");
    } finally {
      setRestartingPod(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="space-y-3 md:hidden">
          {[...Array(4)].map((_, i) => <div key={i} className="h-44 animate-pulse rounded-xl border border-white/10 bg-slate-900/60" />)}
        </div>
        <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-slate-900/60 md:block">
          <table className="w-full">
            <tbody>{[...Array(6)].map((_, i) => <PodRowSkeleton key={i} />)}</tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Server} title="Pods" description="All pods with live status" badge={`${pods.length} total`} />

      <div className="grid gap-3 md:grid-cols-3">
        <DataCard title="Total Pods" value={pods.length} subtitle="Current pod inventory" />
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <DataCard title="Running" value={runningCount} subtitle="Healthy workloads" trend="up" className="border-0 bg-transparent p-0" />
          <ResourceBar value={runningCount} max={pods.length || 1} label="Healthy share" valueFormatter={(_, __, percentage) => `${percentage}%`} className="mt-4" />
        </div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <DataCard title="Unhealthy" value={unhealthyCount} subtitle="Failed or crash looping pods" trend={unhealthyCount > 0 ? "down" : undefined} className="border-0 bg-transparent p-0" />
          <ResourceBar value={unhealthyCount} max={pods.length || 1} label="Problem share" valueFormatter={(_, __, percentage) => `${percentage}%`} tone={unhealthyCount > 0 ? "red" : "emerald"} className="mt-4" />
        </div>
      </div>

      <CommandBar
        actions={[{ label: "Refresh", icon: RefreshCw, onClick: () => void refetch() }]}
        filter={
          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <select
              value={nsFilter}
              onChange={(event) => setNsFilter(event.target.value)}
              className="min-h-[44px] rounded-lg border border-[#333] bg-[#0f0f0f] px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]/50 sm:min-w-[180px]"
            >
              {namespaces.map((namespace) => (
                <option key={namespace} value={namespace}>
                  {namespace === "all" ? "All Namespaces" : namespace}
                </option>
              ))}
            </select>
            <SearchInput value={search} onChange={setSearch} placeholder="Search pods..." className="w-full sm:w-56" />
            <button
              type="button"
              onClick={toggle}
              className={cn(
                "flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors sm:w-auto",
                simpleMode ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400" : "border-[#333] text-[#666] hover:text-[#9e9e9e]",
              )}
            >
              {simpleMode ? "Simple" : "Advanced"}
            </button>
          </div>
        }
      />

      <div className="space-y-3 px-4">
        <div className="-mx-4 overflow-x-auto px-4" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="flex min-w-max gap-2">
            {STATUS_FILTERS.map((filterOption) => (
              <button
                key={filterOption.value}
                type="button"
                onClick={() => setStatusFilter(filterOption.value)}
                className={cn(
                  "min-h-[44px] rounded-full border px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
                  statusFilter === filterOption.value
                    ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                    : "border-white/10 bg-white/5 text-slate-400 hover:text-white",
                )}
              >
                {filterOption.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-[#9e9e9e]">Showing {filteredPods.length} of {pods.length} pods</p>
      </div>

      {filteredPods.length === 0 ? (
        <EmptyState
          icon={Server}
          title={pods.length === 0 ? "No pods found" : "No pods match the current filters"}
          description={
            pods.length === 0
              ? "The cluster did not return any pods. Refresh to try again."
              : "Adjust your namespace, status, or search filters to find a workload."
          }
        />
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {filteredPods.map((pod) => (
              <PodMobileCard
                key={`${pod.namespace}/${pod.name}`}
                pod={pod}
                simpleMode={simpleMode}
                isAdmin={isAdmin}
                restartingPod={restartingPod}
                onRestart={(namespace, name) => void handleRestart(namespace, name)}
              />
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-slate-900/60 backdrop-blur-sm md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Namespace</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-400">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Age</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Restarts</th>
                  {!simpleMode ? <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Node</th> : null}
                  {!simpleMode ? <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Containers</th> : null}
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPods.map((pod) => {
                  const key = `${pod.namespace}/${pod.name}`;
                  const restartCount = pod.restartCount ?? 0;
                  return (
                    <tr key={key} className="border-b border-white/5 transition-colors hover:bg-white/5">
                      <td className="max-w-xs px-4 py-3 text-sm font-medium text-white">
                        <div className="flex items-center gap-2">
                          <Link href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`} className="truncate transition hover:text-indigo-300">
                            {pod.name}
                          </Link>
                          <CopyButton text={pod.name} className="h-11 w-11 justify-center px-0" />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-400">{pod.namespace}</td>
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={pod.status} label={pod.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400" title={pod.createdAt ? new Date(pod.createdAt).toLocaleString() : "Unknown age"}>
                        {pod.createdAt ? timeAgo(pod.createdAt) : "—"}
                      </td>
                      <td className={cn("px-4 py-3 text-xs font-medium", restartColor(restartCount))}>{restartCount}</td>
                      {!simpleMode ? <td className="px-4 py-3 text-xs text-slate-500">{pod.nodeName}</td> : null}
                      {!simpleMode ? <td className="px-4 py-3 text-xs text-slate-400">{Array.isArray(pod.containers) ? pod.containers.join(", ") : ""}</td> : null}
                      <td className="px-4 py-3 text-right">
                        {isAdmin ? (
                          <button
                            type="button"
                            onClick={() => void handleRestart(pod.namespace, pod.name)}
                            disabled={restartingPod === key}
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
                          >
                            <RotateCcw className={cn("h-3.5 w-3.5", restartingPod === key && "animate-spin")} />
                            Restart
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </motion.div>
  );
}
