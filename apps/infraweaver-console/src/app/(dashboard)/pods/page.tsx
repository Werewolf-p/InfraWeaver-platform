"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { CheckSquare, Copy, FileText, Globe, RefreshCw, RotateCcw, Server, Square, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { CommandBar } from "@/components/ui/command-bar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { DataCard } from "@/components/ui/data-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { ResourceBar } from "@/components/ui/resource-bar";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { PodRowSkeleton } from "@/components/ui/skeleton-card";
import { useCluster } from "@/contexts/cluster-context";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { usePermissions } from "@/hooks/use-permissions";
import { usePods, type Pod } from "@/hooks/use-pods";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";

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
  return "text-slate-700 dark:text-slate-300";
}

function podKey(pod: Pick<Pod, "namespace" | "name">) {
  return `${pod.namespace}/${pod.name}`;
}

function PodMobileCard({
  pod,
  simpleMode,
  isAdmin,
  restartingPod,
  selected,
  selectionBusy,
  onRestart,
  onToggleSelection,
}: {
  pod: Pod;
  simpleMode: boolean;
  isAdmin: boolean;
  restartingPod: string | null;
  selected: boolean;
  selectionBusy: boolean;
  onRestart: (namespace: string, name: string) => void;
  onToggleSelection: (pod: Pod) => void;
}) {
  const key = podKey(pod);
  const restartCount = pod.restartCount ?? 0;

  return (
    <div className={cn("rounded-xl border bg-slate-100 dark:bg-slate-900/60 p-4 shadow-sm transition-colors", selected ? "border-indigo-500/40" : "border-gray-200 dark:border-white/10")}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onToggleSelection(pod)}
          disabled={selectionBusy}
          className="mt-0.5 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
          aria-label={selected ? `Deselect ${pod.name}` : `Select ${pod.name}`}
        >
          {selected ? <CheckSquare className="h-4 w-4 text-indigo-300" /> : <Square className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <Link
              href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`}
              className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900 dark:text-white transition hover:text-indigo-300"
            >
              {pod.name}
            </Link>
            <CopyButton text={pod.name} label="Pod" className="h-11" />
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{pod.namespace}</p>
        </div>
        <StatusBadge status={pod.status} label={pod.status} size="sm" />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-slate-500">Age</dt>
          <dd className="mt-1 text-slate-800 dark:text-slate-200">
            <RelativeTime date={pod.createdAt} className="text-slate-800 dark:text-slate-200" />
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
              <dd className="mt-1 truncate text-slate-700 dark:text-slate-300">{pod.nodeName || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Containers</dt>
              <dd className="mt-1 text-slate-700 dark:text-slate-300">{Array.isArray(pod.containers) ? pod.containers.length : 0}</dd>
            </div>
          </>
        ) : null}
      </dl>

      {!simpleMode && Array.isArray(pod.containers) && pod.containers.length > 0 ? (
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{pod.containers.join(", ")}</p>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Link
          href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`}
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-2 text-sm font-medium text-slate-800 dark:text-slate-200 transition hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
        >
          View details
        </Link>
        <Link
          href={`/logs?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}`}
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-2 text-sm font-medium text-sky-200 transition hover:bg-sky-500/20"
        >
          <FileText className="h-4 w-4" />
          Logs
        </Link>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => onRestart(pod.namespace, pod.name)}
            disabled={restartingPod === key || selectionBusy}
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
  const { activeId } = useCluster();
  const { isAdmin } = usePermissions();
  const [nsFilter, setNsFilter] = useLocalStorage<string>("pods-namespace-filter", "all");
  const [statusFilter, setStatusFilter] = useLocalStorage<PodStatusFilter>("pods-status-filter", "all");
  const [search, setSearch] = useLocalStorage("pods-search", "");
  const [restartingPod, setRestartingPod] = useState<string | null>(null);
  const [bulkRestarting, setBulkRestarting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedPods, setSelectedPods] = useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = useState<"restart" | "delete" | null>(null);
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

  const visiblePodKeys = useMemo(() => filteredPods.map((pod) => podKey(pod)), [filteredPods]);
  const selectedVisiblePods = useMemo(
    () => filteredPods.filter((pod) => selectedPods.has(podKey(pod))),
    [filteredPods, selectedPods],
  );

  const namespaces = useMemo(() => ["all", ...new Set(pods.map((pod) => pod.namespace))], [pods]);
  const runningCount = pods.filter((pod) => normalizedStatus(pod.status) === "running").length;
  const unhealthyCount = pods.filter((pod) => {
    const status = normalizedStatus(pod.status);
    return status === "failed" || status === "crashloopbackoff";
  }).length;
  const allVisibleSelected = visiblePodKeys.length > 0 && visiblePodKeys.every((key) => selectedPods.has(key));

  if (activeId === "all") {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Globe className="mb-4 h-10 w-10 text-gray-700 dark:text-[#333]" />
        <p className="text-sm font-medium text-gray-400 dark:text-[#666]">Select a specific cluster to view this page</p>
        <p className="mt-1 text-xs text-gray-400 dark:text-[#444]">Use the cluster selector in the top bar</p>
      </div>
    );
  }

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

  async function handleBulkRestart() {
    if (selectedVisiblePods.length === 0) return;
    setBulkRestarting(true);
    try {
      const response = await fetch("/api/pods/bulk-restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pods: selectedVisiblePods.map((pod) => ({ namespace: pod.namespace, name: pod.name })),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { restartedCount?: number; total?: number; failures?: Array<{ name: string }> ; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to restart selected pods");
      }
      const failures = payload.failures?.length ?? 0;
      if (failures > 0) {
        toast.warning(`Restarted ${payload.restartedCount ?? 0} of ${payload.total ?? selectedVisiblePods.length} pods`);
      } else {
        toast.success(`Restarting ${payload.restartedCount ?? selectedVisiblePods.length} pods`);
      }
      setSelectedPods(new Set());
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to restart selected pods");
    } finally {
      setBulkRestarting(false);
    }
  }

  async function handleBulkDelete() {
    if (selectedVisiblePods.length === 0) return;
    setBulkDeleting(true);
    try {
      const results = await Promise.allSettled(
        selectedVisiblePods.map(async (pod) => {
          const response = await fetch(`/api/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`, {
            method: "DELETE",
          });
          const payload = await response.json().catch(() => ({})) as { error?: string };
          if (!response.ok) throw new Error(payload.error ?? `Failed to delete ${pod.name}`);
          return pod;
        }),
      );

      const deleted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - deleted;
      if (deleted > 0) {
        toast.success(`Deleted ${deleted} pod${deleted === 1 ? "" : "s"}`);
      }
      if (failed > 0) {
        toast.error(`${failed} pod${failed === 1 ? "" : "s"} failed to delete`);
      }
      setSelectedPods(new Set());
      await refetch();
    } finally {
      setBulkDeleting(false);
      setConfirmAction(null);
    }
  }

  async function copySelection() {
    if (selectedVisiblePods.length === 0) return;
    try {
      await navigator.clipboard.writeText(selectedVisiblePods.map((pod) => podKey(pod)).join("\n"));
      toast.success(`Copied ${selectedVisiblePods.length} pod names`);
    } catch {
      toast.error("Failed to copy selected pods");
    }
  }

  function togglePodSelection(pod: Pod) {
    const key = podKey(pod);
    setSelectedPods((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleVisibleSelection() {
    if (allVisibleSelected) {
      setSelectedPods(new Set());
      return;
    }
    setSelectedPods(new Set(visiblePodKeys));
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="space-y-3 md:hidden">
          {[...Array(4)].map((_, i) => <div key={i} className="h-44 animate-pulse rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60" />)}
        </div>
        <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 md:block">
          <table className="w-full">
            <tbody>{[...Array(6)].map((_, i) => <PodRowSkeleton key={i} />)}</tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="space-y-6">
      <PageHeader icon={Server} title="Pods" description="Live pod inventory with bulk triage and direct log jumps" badge={`${pods.length} total`} />

      <div className="grid gap-3 md:grid-cols-3">
        <DataCard title="Total Pods" value={pods.length} subtitle="Current pod inventory" />
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
          <DataCard title="Running" value={runningCount} subtitle="Healthy workloads" trend="up" className="border-0 bg-transparent p-0" />
          <ResourceBar value={runningCount} max={pods.length || 1} label="Healthy share" valueFormatter={(_, __, percentage) => `${percentage}%`} className="mt-4" />
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
          <DataCard title="Unhealthy" value={unhealthyCount} subtitle="Failed or crash looping pods" trend={unhealthyCount > 0 ? "down" : undefined} className="border-0 bg-transparent p-0" />
          <ResourceBar value={unhealthyCount} max={pods.length || 1} label="Problem share" valueFormatter={(_, __, percentage) => `${percentage}%`} tone={unhealthyCount > 0 ? "red" : "emerald"} className="mt-4" />
        </div>
      </div>

      <CommandBar
        primary={
          <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1 text-xs font-medium text-gray-700 dark:text-[#d4d4d4]">
              {selectedVisiblePods.length} selected
            </span>
          </div>
        }
        actions={[
          { label: "Refresh", icon: RefreshCw, onClick: () => void refetch(), disabled: bulkRestarting || bulkDeleting },
          { label: allVisibleSelected ? "Clear visible" : "Select visible", icon: allVisibleSelected ? Square : CheckSquare, onClick: toggleVisibleSelection, disabled: filteredPods.length === 0 || bulkRestarting || bulkDeleting },
          { label: "Copy selection", icon: Copy, onClick: () => void copySelection(), disabled: selectedVisiblePods.length === 0 || bulkRestarting || bulkDeleting },
          ...(isAdmin ? [
            { label: bulkRestarting ? "Restarting…" : "Restart selected", icon: RotateCcw, onClick: () => setConfirmAction("restart"), disabled: selectedVisiblePods.length === 0 || bulkRestarting || bulkDeleting, variant: "primary" as const },
            { label: bulkDeleting ? "Deleting…" : "Delete selected", icon: Trash2, onClick: () => setConfirmAction("delete"), disabled: selectedVisiblePods.length === 0 || bulkRestarting || bulkDeleting, variant: "danger" as const },
          ] : []),
        ]}
        filter={
          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <select
              value={nsFilter}
              onChange={(event) => setNsFilter(event.target.value)}
              className="min-h-[44px] rounded-lg border border-gray-200 dark:border-[#333] bg-white dark:bg-[#0f0f0f] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] outline-none focus:border-[#0078D4]/50 sm:min-w-[180px]"
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
                simpleMode ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400" : "border-gray-200 dark:border-[#333] text-gray-400 dark:text-[#666] hover:text-gray-700 dark:hover:text-[#9e9e9e]",
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
                    : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
                )}
              >
                {filterOption.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-gray-500 dark:text-[#9e9e9e]">Showing {filteredPods.length} of {pods.length} pods</p>
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
                key={podKey(pod)}
                pod={pod}
                simpleMode={simpleMode}
                isAdmin={isAdmin}
                restartingPod={restartingPod}
                selected={selectedPods.has(podKey(pod))}
                selectionBusy={bulkRestarting}
                onRestart={(namespace, name) => void handleRestart(namespace, name)}
                onToggleSelection={togglePodSelection}
              />
            ))}
          </div>

          <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 backdrop-blur-sm md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-white/10">
                  <th className="w-14 px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">
                    <button
                      type="button"
                      onClick={toggleVisibleSelection}
                      className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 transition hover:text-gray-900 dark:hover:text-white"
                      aria-label={allVisibleSelected ? "Clear visible pod selection" : "Select all visible pods"}
                    >
                      {allVisibleSelected ? <CheckSquare className="h-4 w-4 text-indigo-300" /> : <Square className="h-4 w-4" />}
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Namespace</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-500 dark:text-slate-400">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Age</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Restarts</th>
                  {!simpleMode ? <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Node</th> : null}
                  {!simpleMode ? <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Containers</th> : null}
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 dark:text-slate-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPods.map((pod) => {
                  const key = podKey(pod);
                  const restartCount = pod.restartCount ?? 0;
                  const selected = selectedPods.has(key);
                  return (
                    <tr key={key} className={cn("border-b border-gray-200 dark:border-white/5 transition-colors hover:bg-gray-100 dark:hover:bg-white/5", selected && "bg-indigo-500/5") }>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => togglePodSelection(pod)}
                          disabled={bulkRestarting}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white disabled:opacity-50"
                          aria-label={selected ? `Deselect ${pod.name}` : `Select ${pod.name}`}
                        >
                          {selected ? <CheckSquare className="h-4 w-4 text-indigo-300" /> : <Square className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="max-w-xs px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                        <div className="flex items-center gap-2">
                          <Link href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`} className="truncate transition hover:text-indigo-300">
                            {pod.name}
                          </Link>
                          <CopyButton text={pod.name} label="Pod" className="h-9" />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{pod.namespace}</td>
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={pod.status} label={pod.status} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                        <RelativeTime date={pod.createdAt} className="text-xs text-slate-500 dark:text-slate-400" />
                      </td>
                      <td className={cn("px-4 py-3 text-xs font-medium", restartColor(restartCount))}>{restartCount}</td>
                      {!simpleMode ? <td className="px-4 py-3 text-xs text-slate-500">{pod.nodeName}</td> : null}
                      {!simpleMode ? <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">{Array.isArray(pod.containers) ? pod.containers.join(", ") : ""}</td> : null}
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Link
                            href={`/logs?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.name)}`}
                            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-200 transition hover:bg-sky-500/20"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            Logs
                          </Link>
                          {isAdmin ? (
                            <button
                              type="button"
                              onClick={() => void handleRestart(pod.namespace, pod.name)}
                              disabled={restartingPod === key || bulkRestarting}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
                            >
                              <RotateCcw className={cn("h-3.5 w-3.5", restartingPod === key && "animate-spin")} />
                              Restart
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirmAction !== null}
        onConfirm={() => {
          if (confirmAction === "restart") {
            void handleBulkRestart();
            setConfirmAction(null);
            return;
          }
          void handleBulkDelete();
        }}
        onCancel={() => setConfirmAction(null)}
        title={confirmAction === "delete" ? `Delete ${selectedVisiblePods.length} selected pod${selectedVisiblePods.length === 1 ? "" : "s"}?` : `Restart ${selectedVisiblePods.length} selected pod${selectedVisiblePods.length === 1 ? "" : "s"}?`}
        description={confirmAction === "delete"
          ? "This deletes the selected pods immediately. Kubernetes controllers may recreate them if they are managed workloads."
          : "This triggers a restart for each selected pod. Use this when you need to force fresh scheduling or re-read config changes."}
        confirmText={confirmAction === "delete"
          ? (bulkDeleting ? "Deleting…" : "Delete selected")
          : (bulkRestarting ? "Restarting…" : "Restart selected")}
        danger={confirmAction === "delete"}
      />
    </motion.div>
  );
}
