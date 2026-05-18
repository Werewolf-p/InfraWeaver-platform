"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, AlertCircle, CheckCircle2, Search, ArrowUpDown, Activity } from "lucide-react";
import { formatBytes, cn } from "@/lib/utils";
import { StoragePieChart } from "@/components/charts/PieChart";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { EmptyState } from "@/components/ui/empty-state";

interface BreakdownEntry {
  name: string;
  totalGi: number;
  pvcCount: number;
  color: string;
}

interface Volume {
  name: string;
  size: number;
  actualSize: number;
  robustness: string;
  numberOfReplicas: number;
}

interface BackupVolume {
  name: string;
  lastBackupAt: string | null;
  backupCount: number;
  lastBackupState: "Completed" | "Error" | "InProgress" | null;
  ageHours: number | null;
  status: "healthy" | "stale" | "missing";
}

interface BackupStatusResponse {
  volumes: BackupVolume[];
  summary: {
    total: number;
    healthy: number;
    stale: number;
    missing: number;
  };
  maxAgeHours: number;
}

type SortBy = "usage" | "name" | "size" | "replicas" | "health";
type HealthFilter = "all" | "healthy" | "attention" | "critical";

const SORT_OPTIONS: Array<{ value: SortBy; label: string }> = [
  { value: "usage", label: "Highest usage" },
  { value: "name", label: "Name A-Z" },
  { value: "size", label: "Largest provisioned" },
  { value: "replicas", label: "Most replicas" },
  { value: "health", label: "Needs attention first" },
];

const HEALTH_FILTERS: Array<{ value: HealthFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "attention", label: "Attention" },
  { value: "critical", label: "Critical" },
];

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function usagePct(volume: Pick<Volume, "size" | "actualSize">) {
  if (!volume.size || volume.size <= 0) return 0;
  return Math.min(100, Math.round((volume.actualSize / volume.size) * 100));
}

function healthBucket(volume: Volume): Exclude<HealthFilter, "all"> {
  const pct = usagePct(volume);
  if (volume.robustness !== "healthy" || pct >= 85) return "critical";
  if (pct >= 65) return "attention";
  return "healthy";
}

function healthRank(volume: Volume) {
  const bucket = healthBucket(volume);
  return bucket === "critical" ? 0 : bucket === "attention" ? 1 : 2;
}

function formatBackupAge(ageHours: number | null) {
  if (ageHours === null) return "Never";
  if (ageHours < 1) return "<1h";
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  const days = ageHours / 24;
  return `${days >= 10 ? Math.round(days) : days.toFixed(1)}d ago`;
}

function sortVolumes(volumes: Volume[], sortBy: SortBy) {
  return [...volumes].sort((left, right) => {
    if (sortBy === "name") return left.name.localeCompare(right.name);
    if (sortBy === "size") return right.size - left.size;
    if (sortBy === "replicas") return right.numberOfReplicas - left.numberOfReplicas;
    if (sortBy === "health") {
      const byHealth = healthRank(left) - healthRank(right);
      return byHealth !== 0 ? byHealth : usagePct(right) - usagePct(left);
    }
    return usagePct(right) - usagePct(left);
  });
}

export default function StoragePage() {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("usage");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const { data: volumes, isLoading, dataUpdatedAt } = useQuery<Volume[]>({
    queryKey: ["longhorn", "volumes"],
    queryFn: async () => {
      const res = await fetch("/api/longhorn/volumes");
      if (!res.ok) throw new Error("Failed to fetch volumes");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: backupData } = useQuery<BackupStatusResponse>({
    queryKey: ["longhorn", "backup-status"],
    queryFn: async () => {
      const res = await fetch("/api/longhorn/backup-status");
      if (!res.ok) throw new Error("Failed to fetch Longhorn backup status");
      return res.json();
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  const { data: breakdownData } = useQuery<{ breakdown: BreakdownEntry[] }>({
    queryKey: ["storage", "breakdown"],
    queryFn: async () => {
      const res = await fetch("/api/storage/breakdown");
      if (!res.ok) return { breakdown: [] };
      return res.json();
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape" && search) {
        setSearch("");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [search]);

  const summary = useMemo(() => {
    const items = volumes ?? [];
    const healthy = items.filter((volume) => healthBucket(volume) === "healthy").length;
    const attention = items.filter((volume) => healthBucket(volume) !== "healthy").length;
    const critical = items.filter((volume) => healthBucket(volume) === "critical").length;
    const usedBytes = items.reduce((total, volume) => total + (volume.actualSize ?? 0), 0);
    const provisionedBytes = items.reduce((total, volume) => total + (volume.size ?? 0), 0);
    const avgUsage = items.length ? Math.round(items.reduce((total, volume) => total + usagePct(volume), 0) / items.length) : 0;
    const hottest = [...items].sort((left, right) => usagePct(right) - usagePct(left))[0];

    return { total: items.length, healthy, attention, critical, usedBytes, provisionedBytes, avgUsage, hottest };
  }, [volumes]);

  const totalBreakdownGi = useMemo(
    () => (breakdownData?.breakdown ?? []).reduce((total, item) => total + item.totalGi, 0),
    [breakdownData],
  );
  const backupVolumes = backupData?.volumes ?? [];
  const backupSummary = backupData?.summary ?? { total: 0, healthy: 0, stale: 0, missing: 0 };

  const filteredVolumes = useMemo(() => {
    const filtered = (volumes ?? []).filter((volume) => {
      const matchesSearch = volume.name.toLowerCase().includes(search.toLowerCase());
      const matchesHealth = healthFilter === "all" || healthBucket(volume) === healthFilter;
      return matchesSearch && matchesHealth;
    });
    return sortVolumes(filtered, sortBy);
  }, [healthFilter, search, sortBy, volumes]);

  const hasActiveFilters = Boolean(search.trim()) || healthFilter !== "all";

  return (
    <div className="space-y-6">
      <PageHeader icon={HardDrive} title="Storage" subtitle="Persistent volumes, capacity pressure, and replica health" />

      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 sm:p-5">
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Storage workspace</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Desktop-optimized visibility into Longhorn usage, hot volumes, storage class distribution, and backup freshness.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-1.5">Press / to search volumes</span>
          <RefreshCountdown intervalSeconds={60} resetKey={dataUpdatedAt} />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Tracked volumes",
            value: summary.total.toString(),
            description: summary.total > 0 ? `${summary.healthy} healthy · ${summary.attention} need review` : "Waiting for Longhorn data",
            icon: HardDrive,
            tone: "text-[#0078D4] bg-[#0078D4]/10",
          },
          {
            label: "Healthy replicas",
            value: summary.healthy.toString(),
            description: summary.critical > 0 ? `${summary.critical} critical volume${summary.critical === 1 ? "" : "s"}` : "All replica sets look stable",
            icon: CheckCircle2,
            tone: "text-emerald-400 bg-emerald-500/10",
          },
          {
            label: "Provisioned / used",
            value: `${formatBytes(summary.usedBytes)} / ${formatBytes(summary.provisionedBytes)}`,
            description: summary.hottest ? `${summary.hottest.name} is hottest at ${usagePct(summary.hottest)}%` : "No provisioned capacity reported",
            icon: AlertCircle,
            tone: "text-amber-400 bg-amber-500/10",
          },
          {
            label: "Average usage",
            value: `${summary.avgUsage}%`,
            description: summary.avgUsage >= 70 ? "Capacity trend is above the safe operating band" : "Average utilization is within the safe band",
            icon: Activity,
            tone: "text-violet-400 bg-violet-500/10",
          },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{card.label}</p>
                <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{card.value}</p>
              </div>
              <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", card.tone)}>
                <card.icon className="h-5 w-5" />
              </div>
            </div>
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{card.description}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
            <div className="relative min-w-[260px] flex-1 xl:max-w-md">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search volumes, namespaces, or hot paths..."
                className="w-full rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] py-2.5 pl-9 pr-3 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-[#0078D4]/50"
              />
            </div>
            <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 text-xs text-slate-500 dark:text-slate-400">
              <ArrowUpDown className="h-3.5 w-3.5" />
              <select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortBy)} className="bg-transparent text-sm text-gray-900 dark:text-white focus:outline-none">
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-100 dark:bg-slate-900">{option.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {HEALTH_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setHealthFilter(option.value)}
                className={cn(
                  "min-h-[40px] rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  healthFilter === option.value
                    ? "border-[#0078D4]/40 bg-[#0078D4]/10 text-[#7cb9ff]"
                    : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
                )}
              >
                {option.label}
              </button>
            ))}
            {hasActiveFilters ? (
              <button
                type="button"
                onClick={() => { setSearch(""); setHealthFilter("all"); }}
                className="min-h-[40px] rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white"
              >
                Reset
              </button>
            ) : null}
            <span className="text-xs text-slate-500">{filteredVolumes.length} of {summary.total} volumes</span>
          </div>
        </div>
      </div>

      {breakdownData && breakdownData.breakdown.length > 0 && (
        <CollapsibleSection title="Storage by Class" storageKey="storage-breakdown">
          <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <StoragePieChart
              data={breakdownData.breakdown.map((entry) => ({ name: entry.name, value: entry.totalGi, color: entry.color }))}
              unit="Gi"
            />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {breakdownData.breakdown.map((entry) => (
                <div key={entry.name} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-white">{entry.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{entry.pvcCount} PVC{entry.pvcCount === 1 ? "" : "s"}</p>
                    </div>
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{entry.totalGi} Gi</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${totalBreakdownGi > 0 ? Math.max(10, Math.round((entry.totalGi / totalBreakdownGi) * 100)) : 0}%`, backgroundColor: entry.color }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleSection>
      )}

      {backupVolumes.length > 0 && (
        <CollapsibleSection title="Backup status" count={backupSummary.total} storageKey="storage-backup-status">
          <div className="mb-4 grid gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Protected volumes</p>
              <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.total}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Longhorn backup volumes detected on the TrueNAS target.</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Current backups</p>
              <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.healthy}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Recovered within the {backupData?.maxAgeHours ?? 36}h freshness window.</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Stale backups</p>
              <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.stale}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Backups that are too old or ended in an error state.</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Missing backups</p>
              <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.missing}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Volumes that have never produced a remote backup yet.</p>
            </div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Volume</th>
                  <th className="px-4 py-3 text-left font-medium">Status</th>
                  <th className="px-4 py-3 text-left font-medium">Last backup</th>
                  <th className="px-4 py-3 text-left font-medium">Age</th>
                  <th className="px-4 py-3 text-left font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {backupVolumes.map((volume) => (
                  <tr key={volume.name} className="border-t border-[#1c1c1c] text-slate-700 dark:text-slate-300">
                    <td className="px-4 py-4">
                      <p className="font-medium text-gray-900 dark:text-white">{volume.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{volume.lastBackupState ?? "No backup yet"}</p>
                    </td>
                    <td className="px-4 py-4">
                      <span className={cn("rounded-full px-2 py-1 text-xs font-medium", volume.status === "healthy" ? "bg-emerald-500/10 text-emerald-300" : volume.status === "stale" ? "bg-amber-500/10 text-amber-300" : "bg-red-500/10 text-red-300")}>{volume.status}</span>
                    </td>
                    <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.lastBackupAt ? new Date(volume.lastBackupAt).toLocaleString() : "Never"}</td>
                    <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{formatBackupAge(volume.ageHours)}</td>
                    <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.backupCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CollapsibleSection>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] lg:block">
            <div className="h-12 border-b border-gray-200 dark:border-[#2a2a2a] bg-gray-100 dark:bg-white/5 animate-pulse" />
            {[...Array(6)].map((_, index) => <div key={index} className="h-16 border-b border-gray-200 dark:border-[#1a1a1a] bg-white/5/0 animate-pulse" />)}
          </div>
          <div className="grid gap-3 lg:hidden">
            {[...Array(4)].map((_, index) => <div key={index} className="h-28 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-100 dark:bg-white/5 animate-pulse" />)}
          </div>
        </div>
      ) : filteredVolumes.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title={hasActiveFilters ? "No volumes match the current filters" : "No storage volumes found"}
          description={hasActiveFilters ? "Try clearing your search or broadening the health filter to bring volumes back into view." : "Longhorn did not return any volumes. Refresh this page after confirming the storage API is reachable."}
          action={hasActiveFilters ? { label: "Clear filters", onClick: () => { setSearch(""); setHealthFilter("all"); } } : undefined}
        />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] lg:block">
            <table className="w-full text-sm">
              <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  {[
                    ["name", "Volume"],
                    ["health", "Health"],
                    ["replicas", "Replicas"],
                    ["size", "Provisioned"],
                    ["usage", "Usage"],
                  ].map(([value, label]) => (
                    <th key={value} className="px-4 py-3 text-left font-medium">
                      <button
                        type="button"
                        onClick={() => setSortBy(value as SortBy)}
                        className={cn("inline-flex items-center gap-1 transition-colors hover:text-gray-900 dark:hover:text-white", sortBy === value && "text-[#7cb9ff]")}
                      >
                        {label}
                        <ArrowUpDown className="h-3 w-3" />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredVolumes.map((volume) => {
                  const pct = usagePct(volume);
                  const bucket = healthBucket(volume);
                  const healthy = bucket === "healthy";
                  return (
                    <tr key={volume.name} className="border-t border-[#1c1c1c] transition-colors hover:bg-white/[0.03]">
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white dark:bg-[#0d0d0d] text-slate-500 dark:text-slate-400">
                            <HardDrive className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-gray-900 dark:text-white">{volume.name}</p>
                            <p className="mt-1 text-xs text-slate-500">{pct}% utilized</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          {healthy ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertCircle className="h-4 w-4 text-amber-400" />}
                          <span className={cn("rounded-full border px-2 py-1 text-xs font-medium", healthy ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : bucket === "critical" ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300")}>{volume.robustness}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.numberOfReplicas}x</td>
                      <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{formatBytes(volume.size ?? 0)}</td>
                      <td className="px-4 py-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
                            <span>{formatBytes(volume.actualSize ?? 0)} used</span>
                            <span className={cn("font-medium", bucket === "critical" ? "text-red-300" : bucket === "attention" ? "text-amber-300" : "text-emerald-300")}>{pct}%</span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                            <div className={cn("h-full rounded-full transition-all", bucket === "critical" ? "bg-red-500" : bucket === "attention" ? "bg-amber-500" : "bg-[#0078D4]")} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-3 lg:hidden">
            {filteredVolumes.map((volume) => {
              const pct = usagePct(volume);
              const bucket = healthBucket(volume);
              const healthy = bucket === "healthy";
              return (
                <motion.div key={volume.name} whileHover={{ x: 2 }} whileTap={{ scale: 0.99 }} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <HardDrive className="h-4 w-4 text-slate-500 dark:text-slate-400" />
                        <span className="truncate text-sm font-medium text-gray-900 dark:text-white">{volume.name}</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{volume.numberOfReplicas} replicas</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {healthy ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertCircle className="h-4 w-4 text-amber-400" />}
                      <span className={cn("text-xs font-medium", healthy ? "text-emerald-300" : bucket === "critical" ? "text-red-300" : "text-amber-300")}>{volume.robustness}</span>
                    </div>
                  </div>
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span>{formatBytes(volume.actualSize ?? 0)} of {formatBytes(volume.size ?? 0)}</span>
                      <span className={cn("font-medium", bucket === "critical" ? "text-red-300" : bucket === "attention" ? "text-amber-300" : "text-emerald-300")}>{pct}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]">
                      <div className={cn("h-full rounded-full transition-all", bucket === "critical" ? "bg-red-500" : bucket === "attention" ? "bg-amber-500" : "bg-[#0078D4]")} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
