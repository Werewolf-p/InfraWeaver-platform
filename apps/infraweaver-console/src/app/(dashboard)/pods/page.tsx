"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Server, RefreshCw, Copy, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { CommandBar } from "@/components/ui/command-bar";
import { cn, timeAgo } from "@/lib/utils";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { PodRowSkeleton } from "@/components/ui/skeleton-card";
import { useRBAC } from "@/hooks/use-rbac";
import { toast } from "sonner";

interface Pod {
  name: string;
  namespace: string;
  status: string;
  containers: string[];
  nodeName: string;
  createdAt: string;
  restartCount?: number;
}

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

function statusColor(status: string) {
  const normalized = normalizedStatus(status);
  if (normalized === "running") return "bg-green-500/10 text-green-400 border-green-500/20";
  if (normalized === "pending") return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  if (normalized === "failed") return "bg-red-500/10 text-red-400 border-red-500/20";
  if (normalized === "crashloopbackoff") return "bg-orange-500/10 text-orange-300 border-orange-500/20";
  return "bg-slate-500/10 text-slate-400 border-slate-500/20";
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
  onCopy,
}: {
  pod: Pod;
  simpleMode: boolean;
  isAdmin: boolean;
  restartingPod: string | null;
  onRestart: (namespace: string, name: string) => void;
  onCopy: (name: string) => void;
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
            <button
              onClick={() => onCopy(pod.name)}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-400 transition hover:bg-white/10 hover:text-white"
              title="Copy pod name"
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-1 text-sm text-slate-400">{pod.namespace}</p>
        </div>
        <span className={cn("inline-flex min-h-[32px] items-center rounded-full border px-2.5 py-1 text-sm font-medium", statusColor(pod.status))}>
          {pod.status}
        </span>
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
        {!simpleMode && (
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
        )}
      </dl>

      {!simpleMode && Array.isArray(pod.containers) && pod.containers.length > 0 && (
        <p className="mt-3 text-sm text-slate-400">{pod.containers.join(", ")}</p>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Link
          href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`}
          className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 hover:text-white"
        >
          View details
        </Link>
        {isAdmin && (
          <button
            onClick={() => onRestart(pod.namespace, pod.name)}
            disabled={restartingPod === key}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
          >
            <RotateCcw className={cn("h-4 w-4", restartingPod === key && "animate-spin")} />
            Restart
          </button>
        )}
      </div>
    </div>
  );
}

export default function PodsPage() {
  const { isAdmin } = useRBAC();
  const [nsFilter, setNsFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<PodStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [restartingPod, setRestartingPod] = useState<string | null>(null);
  const { simpleMode, toggle } = useSimpleMode();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pods"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Pod[]>;
    },
    refetchInterval: 30000,
  });

  const pods = data ?? [];
  const namespaces = ["all", ...new Set(pods.map((pod) => pod.namespace))];

  const filtered = pods.filter((pod) =>
    (nsFilter === "all" || pod.namespace === nsFilter) &&
    (statusFilter === "all" || normalizedStatus(pod.status) === statusFilter) &&
    (!search || pod.name.toLowerCase().includes(search.toLowerCase()))
  );

  async function handleRestart(namespace: string, name: string) {
    setRestartingPod(`${namespace}/${name}`);
    try {
      const res = await fetch("/api/pods/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace, name }),
      });
      if (!res.ok) throw new Error("Failed to restart pod");
      toast.success(`Restarting ${name}`);
      await refetch();
    } catch {
      toast.error("Failed to restart pod");
    } finally {
      setRestartingPod(null);
    }
  }

  async function handleCopy(name: string) {
    await navigator.clipboard.writeText(name);
    toast.success("Copied!");
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="space-y-3 md:hidden">
          {[...Array(4)].map((_, i) => <div key={i} className="h-44 rounded-xl border border-white/10 bg-slate-900/60 animate-pulse" />)}
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
      <PageHeader icon={Server} title="Pods" subtitle="All pods with live status" />
      <CommandBar
        actions={[{ label: "Refresh", icon: RefreshCw, onClick: () => void refetch() }]}
        filter={
          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
            <select value={nsFilter} onChange={(e) => setNsFilter(e.target.value)} className="min-h-[44px] rounded-lg border border-[#333] bg-[#0f0f0f] px-3 py-2 text-sm text-[#f2f2f2] outline-none focus:border-[#0078D4]/50 sm:min-w-[180px]">
              {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace === "all" ? "All Namespaces" : namespace}</option>)}
            </select>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search pods..." className="min-h-[44px] w-full rounded-lg border border-[#333] bg-[#0f0f0f] px-3 py-2 text-base text-[#f2f2f2] placeholder:text-[#555] outline-none focus:border-[#0078D4]/50 sm:w-56 sm:text-sm" />
            <button
              onClick={toggle}
              className={cn(
                "flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors sm:w-auto",
                simpleMode ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400" : "border-[#333] text-[#666] hover:text-[#9e9e9e]"
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
                onClick={() => setStatusFilter(filterOption.value)}
                className={cn(
                  "min-h-[44px] rounded-full border px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
                  statusFilter === filterOption.value
                    ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                    : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
                )}
              >
                {filterOption.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-[#9e9e9e]">Showing {filtered.length} of {pods.length} pods</p>
      </div>

      <div className="space-y-3 md:hidden">
        {filtered.map((pod) => (
          <PodMobileCard
            key={`${pod.namespace}/${pod.name}`}
            pod={pod}
            simpleMode={simpleMode}
            isAdmin={isAdmin}
            restartingPod={restartingPod}
            onRestart={(namespace, name) => void handleRestart(namespace, name)}
            onCopy={(name) => void handleCopy(name)}
          />
        ))}
        {filtered.length === 0 && <div className="rounded-xl border border-white/10 bg-slate-900/60 py-12 text-center text-sm text-slate-500">No pods match filters</div>}
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
              {!simpleMode && <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Node</th>}
              {!simpleMode && <th className="px-4 py-3 text-left text-xs font-semibold text-slate-400">Containers</th>}
              {isAdmin && <th className="px-4 py-3 text-right text-xs font-semibold text-slate-400">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((pod) => {
              const key = `${pod.namespace}/${pod.name}`;
              const restartCount = pod.restartCount ?? 0;
              return (
                <tr key={key} className="border-b border-white/5 transition-colors hover:bg-white/5">
                  <td className="max-w-xs px-4 py-3 text-sm font-medium text-white">
                    <div className="flex items-center gap-2">
                      <Link href={`/pods/${encodeURIComponent(pod.namespace)}/${encodeURIComponent(pod.name)}`} className="truncate transition hover:text-indigo-300">
                        {pod.name}
                      </Link>
                      <button onClick={() => void handleCopy(pod.name)} className="flex h-11 w-11 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-500 transition hover:bg-white/10 hover:text-white" title="Copy pod name">
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-400">{pod.namespace}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={cn("inline-flex min-h-[32px] items-center rounded-full border px-2.5 py-1 text-xs", statusColor(pod.status))}>{pod.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400" title={pod.createdAt ? new Date(pod.createdAt).toLocaleString() : "Unknown age"}>
                    {pod.createdAt ? timeAgo(pod.createdAt) : "—"}
                  </td>
                  <td className={cn("px-4 py-3 text-xs font-medium", restartColor(restartCount))}>{restartCount}</td>
                  {!simpleMode && <td className="px-4 py-3 text-xs text-slate-500">{pod.nodeName}</td>}
                  {!simpleMode && <td className="px-4 py-3 text-xs text-slate-400">{Array.isArray(pod.containers) ? pod.containers.join(", ") : ""}</td>}
                  {isAdmin && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => void handleRestart(pod.namespace, pod.name)}
                        disabled={restartingPod === key}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
                      >
                        <RotateCcw className={cn("h-3.5 w-3.5", restartingPod === key && "animate-spin")} />
                        Restart
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="py-12 text-center text-sm text-slate-500">No pods match filters</div>}
      </div>
    </motion.div>
  );
}
