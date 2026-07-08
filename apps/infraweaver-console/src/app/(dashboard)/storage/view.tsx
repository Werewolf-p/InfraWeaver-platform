"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { HardDrive, AlertCircle, CheckCircle2, Search, ArrowUpDown, Activity, Server, Lock, Unlock, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { formatBytes, cn } from "@/lib/utils";
import { StoragePieChart } from "@/components/charts/PieChart";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { EmptyState } from "@/components/ui/empty-state";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  useNasProviders,
  useNasMounts,
  useNasAddProvider,
  useNasDeleteProvider,
  type NasMount,
  type NasProvider,
  type NasProviderInput,
  type NasProviderKind,
} from "@/hooks/use-nas";

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

export function StorageVolumesView() {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("usage");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  // Tabs: default to Longhorn (existing behaviour). "nas" swaps the lower
  // section for the NAS providers + mounts table (plan §4).
  const [tab, setTab] = useState<"longhorn" | "nas">("longhorn");
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

      {/* Storage-source tabs — Longhorn (in-cluster) vs NAS & external (SMB/CSI). Plan §4. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-2">
        {[
          { id: "longhorn" as const, label: "Longhorn", icon: HardDrive },
          { id: "nas" as const, label: "NAS & external", icon: Server },
        ].map((option) => {
          const active = tab === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => setTab(option.id)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-[#0078D4]/10 text-[#7cb9ff]"
                  : "text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
              )}
            >
              <option.icon className="h-4 w-4" />
              {option.label}
            </button>
          );
        })}
      </div>

      {tab === "nas" ? (
        <NasSection />
      ) : (
        <LonghornPanel
          isLoading={isLoading}
          filteredVolumes={filteredVolumes}
          volumes={volumes ?? []}
          summary={summary}
          breakdownData={breakdownData}
          totalBreakdownGi={totalBreakdownGi}
          backupData={backupData}
          backupVolumes={backupVolumes}
          backupSummary={backupSummary}
          search={search}
          setSearch={setSearch}
          searchRef={searchRef}
          sortBy={sortBy}
          setSortBy={setSortBy}
          healthFilter={healthFilter}
          setHealthFilter={setHealthFilter}
          hasActiveFilters={hasActiveFilters}
        />
      )}
    </div>
  );
}

interface LonghornPanelProps {
  isLoading: boolean;
  filteredVolumes: Volume[];
  volumes: Volume[];
  summary: {
    total: number;
    healthy: number;
    attention: number;
    critical: number;
    usedBytes: number;
    provisionedBytes: number;
    avgUsage: number;
    hottest?: Volume;
  };
  breakdownData: { breakdown: BreakdownEntry[] } | undefined;
  totalBreakdownGi: number;
  backupData: BackupStatusResponse | undefined;
  backupVolumes: BackupVolume[];
  backupSummary: { total: number; healthy: number; stale: number; missing: number };
  search: string;
  setSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  sortBy: SortBy;
  setSortBy: (v: SortBy) => void;
  healthFilter: HealthFilter;
  setHealthFilter: (v: HealthFilter) => void;
  hasActiveFilters: boolean;
}

function LonghornPanel({
  isLoading, filteredVolumes, summary, breakdownData, totalBreakdownGi,
  backupData, backupVolumes, backupSummary, search, setSearch, searchRef,
  sortBy, setSortBy, healthFilter, setHealthFilter, hasActiveFilters,
}: LonghornPanelProps) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{longhornSummaryCards(summary)}</div>
      {longhornFilterBar({ search, setSearch, searchRef, sortBy, setSortBy, healthFilter, setHealthFilter, hasActiveFilters, filteredCount: filteredVolumes.length, total: summary.total })}
      {longhornBreakdown(breakdownData, totalBreakdownGi)}
      {longhornBackups(backupVolumes, backupSummary, backupData)}
      {longhornVolumeList({ isLoading, filteredVolumes, sortBy, setSortBy, setSearch, setHealthFilter, hasActiveFilters })}
    </>
  );
}

function NasSection() {
  const providersQuery = useNasProviders();
  const mountsQuery = useNasMounts();
  const deleteProvider = useNasDeleteProvider();
  const providers = providersQuery.data ?? [];
  const mounts = useMemo(() => mountsQuery.data ?? [], [mountsQuery.data]);
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [accessFilter, setAccessFilter] = useState<"all" | "ro" | "rw">("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<NasProvider | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NasProvider | null>(null);
  const filteredMounts = useMemo(
    () => mounts.filter((m) => (providerFilter === "all" || m.provider === providerFilter) && (accessFilter === "all" || m.access === accessFilter)),
    [mounts, providerFilter, accessFilter],
  );
  const roCount = mounts.filter((m) => m.access === "ro").length;
  const rwCount = mounts.length - roCount;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="NAS providers" value={providers.length.toString()} description={`${providers.filter((p) => p.reachable).length} reachable`} icon={Server} tone="text-[#0078D4] bg-[#0078D4]/10" />
        <SummaryCard label="NAS-backed PVCs" value={mounts.length.toString()} description="Across all namespaces" icon={HardDrive} tone="text-cyan-400 bg-cyan-500/10" />
        <SummaryCard label="Read-only mounts" value={roCount.toString()} description="Enforced RO at SC + pod" icon={Lock} tone="text-emerald-400 bg-emerald-500/10" />
        <SummaryCard label="Read-write mounts" value={rwCount.toString()} description="Writable NAS credentials" icon={Unlock} tone="text-amber-400 bg-amber-500/10" />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Providers</h3>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Synology / TrueNAS backends. Credentials are stored in OpenBao and read at request time.</p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-1.5 text-xs font-medium text-[#7cb9ff] transition-colors hover:bg-[#0078D4]/20"
        >
          <Plus className="h-3.5 w-3.5" />
          Add provider
        </button>
      </div>

      <CollapsibleSection title="Configured providers" count={providers.length} storageKey="storage-nas-providers">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.length === 0 ? (
            <EmptyState
              icon={Server}
              title="No NAS providers configured"
              description="Add a Synology or TrueNAS provider — its credentials are stored securely in OpenBao."
              action={{ label: "Add provider", onClick: () => setAddOpen(true) }}
            />
          ) : providers.map((p) => (
            <div key={p.id} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{p.name}</p>
                  <p className="mt-1 truncate text-xs text-slate-500">{p.protocol}://{p.host}:{p.port}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", p.reachable ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300")}>
                      {p.reachable ? "reachable" : "unreachable"}
                    </span>
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", p.hasCredentials ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300")}>
                      {p.hasCredentials ? "credentials set" : "no credentials"}
                    </span>
                    <span className="rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-400">
                      {p.source === "openbao" ? "OpenBao" : "environment"}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    aria-label={`Edit ${p.name}`}
                    title={p.source === "openbao" ? "Edit provider" : "Override this built-in provider (saves to OpenBao)"}
                    className="rounded-lg border border-gray-200 dark:border-white/10 p-1.5 text-slate-400 transition-colors hover:border-[#0078D4]/40 hover:text-[#7cb9ff]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {p.source === "openbao" ? (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(p)}
                      aria-label={`Delete ${p.name}`}
                      title="Delete provider"
                      className="rounded-lg border border-gray-200 dark:border-white/10 p-1.5 text-slate-400 transition-colors hover:border-red-500/40 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </CollapsibleSection>

      <ProviderSheet key="add-new" open={addOpen} onClose={() => setAddOpen(false)} />
      <ProviderSheet
        key={editing ? `edit-${editing.id}` : "edit-idle"}
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        initial={editing}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete NAS provider"
        description={pendingDelete ? `Remove "${pendingDelete.name}" and its stored credentials from OpenBao? Existing mounts are not affected.` : ""}
        confirmText="Delete"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteProvider.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Provider
            <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="rounded-md border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1 text-sm text-gray-900 dark:text-white">
              <option value="all">All</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            Access
            <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value as "all" | "ro" | "rw")} className="rounded-md border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1 text-sm text-gray-900 dark:text-white">
              <option value="all">All</option>
              <option value="ro">Read-only</option>
              <option value="rw">Read-write</option>
            </select>
          </label>
          <span className="ml-auto text-xs text-slate-500">{filteredMounts.length} of {mounts.length} mounts</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left font-medium">App / namespace</th>
              <th className="px-4 py-3 text-left font-medium">Provider</th>
              <th className="px-4 py-3 text-left font-medium">Share / subfolder</th>
              <th className="px-4 py-3 text-left font-medium">Access</th>
              <th className="px-4 py-3 text-left font-medium">Bound pod</th>
              <th className="px-4 py-3 text-left font-medium">Mount path</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {filteredMounts.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">No NAS-backed volumes match the current filters.</td></tr>
            ) : filteredMounts.map((m) => <NasMountRow key={`${m.pvcNamespace}/${m.pvcName}/${m.pod ?? "unbound"}`} mount={m} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NasMountRow({ mount }: { mount: NasMount }) {
  return (
    <tr className="border-t border-[#1c1c1c] text-slate-700 dark:text-slate-300">
      <td className="px-4 py-3">
        <p className="font-medium text-gray-900 dark:text-white">{mount.user || mount.pvcName}</p>
        <p className="mt-1 text-xs text-slate-500">{mount.pvcNamespace} / {mount.pvcName}</p>
      </td>
      <td className="px-4 py-3">{mount.provider}</td>
      <td className="px-4 py-3">
        <p className="text-xs">{mount.source ?? "—"}</p>
        <p className="mt-1 text-xs text-slate-500">{mount.subDir ? `/${mount.subDir}` : "(root)"}</p>
      </td>
      <td className="px-4 py-3">
        <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium", mount.access === "ro" ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300")}>
          {mount.access === "ro" ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
          {mount.access.toUpperCase()}
        </span>
      </td>
      <td className="px-4 py-3">
        {mount.pod ? <><p className="text-xs">{mount.pod}</p><p className="mt-1 text-xs text-slate-500">{mount.podPhase}</p></> : <span className="text-xs text-slate-500">unbound</span>}
      </td>
      <td className="px-4 py-3 text-xs">{mount.mountPath ?? "—"}</td>
      <td className="px-4 py-3">
        <span className={cn("rounded-full px-2 py-1 text-xs font-medium", mount.phase === "Bound" ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300")}>{mount.phase ?? "unknown"}</span>
      </td>
    </tr>
  );
}

function SummaryCard({ label, value, description, icon: Icon, tone }: { label: string; value: string; description: string; icon: React.ComponentType<{ className?: string }>; tone: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
          <p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{value}</p>
        </div>
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", tone)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

const PROVIDER_INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-slate-400 focus:border-[#0078D4]/50 focus:outline-none focus:ring-1 focus:ring-[#0078D4]/40";

const KIND_OPTIONS: Array<{ value: NasProviderKind; label: string; portHint: string }> = [
  { value: "synology", label: "Synology (SMB)", portHint: "5001" },
  { value: "truenas", label: "TrueNAS Scale (SMB/NFS)", portHint: "443" },
];

/** Slide-over form to register a NEW NAS provider, or edit an existing one.
 *
 *  Add mode  (initial=null): full form, credentials required.
 *  Edit mode (initial set): kind is fixed (a different kind = different provider,
 *  delete + add), credentials are optional — leaving them blank preserves the
 *  stored ones so the operator can rename / change host without re-entering
 *  the NAS password. In both modes the server runs the live save-and-test
 *  probe before persisting, so nothing changes on a bad host or wrong creds. */
function ProviderSheet({ open, onClose, initial }: { open: boolean; onClose: () => void; initial?: NasProvider | null }) {
  const saveProvider = useNasAddProvider();
  const isEdit = Boolean(initial);
  // A built-in (env-sourced) provider has no OpenBao secret yet, so saving one
  // for the first time still needs full credentials (the upsert has nothing
  // to merge with). Once saved it becomes source=openbao and future edits can
  // leave the credential fields blank to keep the stored NAS password.
  const isOverridingEnv = initial?.source === "env";
  const canKeepStoredCreds = isEdit && !isOverridingEnv;
  // State is seeded from `initial` on mount. The parent gives this sheet a
  // `key` derived from initial?.id, so React remounts the component whenever
  // the operator switches between add and edit (or between different edit
  // targets), giving us a clean re-seed without a setState-in-effect.
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<NasProviderKind>((initial?.kind ?? "synology") as NasProviderKind);
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial ? String(initial.port) : "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Least-privilege provisioning: on a NEW provider, default to using the
  // entered credential as a one-time admin credential to mint a scoped service
  // account. Off in edit mode (the scoped account already exists).
  const [provisionScoped, setProvisionScoped] = useState(!isEdit);
  const adminMode = !isEdit && provisionScoped;

  function close() {
    onClose();
  }

  async function submit() {
    setError(null);
    setNotice(null);
    // In edit mode, blank credential fields mean "keep the stored ones" — the
    // API's upsertStoredNasProvider merges with the prior secret so we don't
    // have to prompt the operator for the NAS password just to rename a box.
    const credentials = kind === "synology"
      ? { ...(username ? { username } : {}), ...(password ? { password } : {}) }
      : { ...(apiKey ? { apiKey } : {}) };
    const input: NasProviderInput = {
      ...(isEdit && initial ? { id: initial.id } : {}),
      name: name.trim(),
      kind,
      host: host.trim(),
      credentials,
      ...(port.trim() ? { port: Number(port.trim()) } : {}),
      ...(adminMode ? { provisionScoped: true } : {}),
    };
    try {
      const result = await saveProvider.mutateAsync(input);
      if (result.provisioned?.warning) {
        // Provider is saved; keep the sheet open so the operator sees the
        // one non-fatal caveat (e.g. a share grant to finish manually).
        setNotice(result.provisioned.warning);
      } else {
        close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    }
  }

  const credsReady = canKeepStoredCreds
    ? true // OpenBao secret already stored — blank fields mean "keep them"
    : kind === "synology" ? Boolean(username && password) : Boolean(apiKey);
  const canSave = Boolean(name.trim()) && Boolean(host.trim()) && credsReady && !saveProvider.isPending;
  const portHint = KIND_OPTIONS.find((k) => k.value === kind)?.portHint ?? "";

  return (
    <ResponsiveSheet
      open={open}
      onClose={close}
      title={isEdit ? `Edit ${initial?.name ?? "provider"}` : "Add NAS provider"}
      description={
        isOverridingEnv
          ? "This is a built-in provider from environment variables. Saving here writes an OpenBao entry that overrides it — enter credentials so the live save-and-test can run."
          : canKeepStoredCreds
            ? "Blank credential fields keep the stored NAS password. Every save re-tests against the live NAS."
            : "Credentials are tested against the live NAS, then stored in OpenBao."
      }
      size="sm"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={close} className="rounded-lg border border-gray-200 dark:border-white/10 px-4 py-2 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white">Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave}
            className={cn(
              "flex min-h-[40px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              canSave ? "border border-[#0078D4]/30 bg-[#0078D4]/20 text-[#7cb9ff] hover:bg-[#0078D4]/30" : "border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-400",
            )}
          >
            {saveProvider.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save &amp; test
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Display name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Media NAS" autoComplete="off" spellCheck={false} className={PROVIDER_INPUT_CLASS} />
        </label>

        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Type</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as NasProviderKind)}
            disabled={isEdit}
            title={isEdit ? "Type is fixed after creation — delete + re-add to change it" : undefined}
            className={cn(PROVIDER_INPUT_CLASS, isEdit && "cursor-not-allowed opacity-60")}
          >
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="block">
            <span className="text-xs text-slate-500 dark:text-slate-400">Host / IP</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.25.0.21" autoComplete="off" spellCheck={false} className={PROVIDER_INPUT_CLASS} />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500 dark:text-slate-400">Port</span>
            <input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder={portHint} inputMode="numeric" className={cn(PROVIDER_INPUT_CLASS, "w-24")} />
          </label>
        </div>

        {!isEdit ? (
          <label className="flex items-start gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2">
            <input
              type="checkbox"
              checked={provisionScoped}
              onChange={(e) => setProvisionScoped(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#0078D4]"
            />
            <span className="text-xs text-slate-600 dark:text-slate-300">
              <span className="font-medium text-gray-900 dark:text-white">Create a least-privilege service account</span>{" "}
              <span className="text-slate-500 dark:text-slate-400">(recommended)</span>
              <span className="mt-1 block text-slate-500 dark:text-slate-400">
                Enter a temporary {kind === "synology" ? "admin" : "admin API"} credential below. It is used once to create a
                dedicated scoped account for InfraWeaver, which is stored in the vault — your admin credential is never saved.
              </span>
            </span>
          </label>
        ) : null}

        {kind === "synology" ? (
          <>
            <label className="block">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {adminMode ? "Admin username (used once)" : `Username${canKeepStoredCreds ? " (leave blank to keep stored)" : ""}`}
              </span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={adminMode ? "admin" : canKeepStoredCreds ? "•••••••• (unchanged)" : "console-svc"} autoComplete="off" spellCheck={false} className={PROVIDER_INPUT_CLASS} />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {adminMode ? "Admin password (used once)" : `Password${canKeepStoredCreds ? " (leave blank to keep stored)" : ""}`}
              </span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={adminMode ? "admin password" : canKeepStoredCreds ? "•••••••• (unchanged)" : "NAS account password"} autoComplete="new-password" spellCheck={false} className={PROVIDER_INPUT_CLASS} />
            </label>
          </>
        ) : (
          <label className="block">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {adminMode ? "Admin API key (used once)" : `API key${canKeepStoredCreds ? " (leave blank to keep stored)" : ""}`}
            </span>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={adminMode ? "admin API key" : canKeepStoredCreds ? "•••••••• (unchanged)" : "TrueNAS API key"} autoComplete="new-password" spellCheck={false} className={PROVIDER_INPUT_CLASS} />
          </label>
        )}

        <p className="text-xs text-slate-500 dark:text-slate-400">
          Any private-network host is accepted (RFC1918, loopback, link-local,
          <code className="mx-1 rounded bg-slate-500/10 px-1">.local</code>,
          single-label intranet, or any <code className="mx-1 rounded bg-slate-500/10 px-1">*.int</code> name).
          Public/external hosts must be added to the platform allowlist first.
        </p>

        {error ? <p className="text-xs text-red-400">{error}</p> : null}
        {notice ? <p className="text-xs text-amber-400">Saved. {notice}</p> : null}
      </div>
    </ResponsiveSheet>
  );
}

// Local helpers below split the Longhorn panel JSX into single-use factories to
// keep StorageVolumesView compact. They are intentionally not exported.

function longhornSummaryCards(summary: LonghornPanelProps["summary"]) {
  const cards = [
    { label: "Tracked volumes", value: summary.total.toString(), description: summary.total > 0 ? `${summary.healthy} healthy · ${summary.attention} need review` : "Waiting for Longhorn data", icon: HardDrive, tone: "text-[#0078D4] bg-[#0078D4]/10" },
    { label: "Healthy replicas", value: summary.healthy.toString(), description: summary.critical > 0 ? `${summary.critical} critical volume${summary.critical === 1 ? "" : "s"}` : "All replica sets look stable", icon: CheckCircle2, tone: "text-emerald-400 bg-emerald-500/10" },
    { label: "Provisioned / used", value: `${formatBytes(summary.usedBytes)} / ${formatBytes(summary.provisionedBytes)}`, description: summary.hottest ? `${summary.hottest.name} is hottest at ${usagePct(summary.hottest)}%` : "No provisioned capacity reported", icon: AlertCircle, tone: "text-amber-400 bg-amber-500/10" },
    { label: "Average usage", value: `${summary.avgUsage}%`, description: summary.avgUsage >= 70 ? "Capacity trend is above the safe operating band" : "Average utilization is within the safe band", icon: Activity, tone: "text-violet-400 bg-violet-500/10" },
  ];
  return cards.map((card) => <SummaryCard key={card.label} {...card} />);
}

function longhornFilterBar(props: {
  search: string;
  setSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  sortBy: SortBy;
  setSortBy: (v: SortBy) => void;
  healthFilter: HealthFilter;
  setHealthFilter: (v: HealthFilter) => void;
  hasActiveFilters: boolean;
  filteredCount: number;
  total: number;
}) {
  const { search, setSearch, searchRef, sortBy, setSortBy, healthFilter, setHealthFilter, hasActiveFilters, filteredCount, total } = props;
  return (
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
            <button key={option.value} type="button" onClick={() => setHealthFilter(option.value)} className={cn("min-h-[40px] rounded-full border px-3 py-1.5 text-xs font-medium transition-colors", healthFilter === option.value ? "border-[#0078D4]/40 bg-[#0078D4]/10 text-[#7cb9ff]" : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white")}>{option.label}</button>
          ))}
          {hasActiveFilters ? (
            <button type="button" onClick={() => { setSearch(""); setHealthFilter("all"); }} className="min-h-[40px] rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white">Reset</button>
          ) : null}
          <span className="text-xs text-slate-500">{filteredCount} of {total} volumes</span>
        </div>
      </div>
    </div>
  );
}

function longhornBreakdown(breakdownData: { breakdown: BreakdownEntry[] } | undefined, totalBreakdownGi: number) {
  if (!breakdownData || breakdownData.breakdown.length === 0) return null;
  return (
    <CollapsibleSection title="Storage by Class" storageKey="storage-breakdown">
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <StoragePieChart data={breakdownData.breakdown.map((entry) => ({ name: entry.name, value: entry.totalGi, color: entry.color }))} unit="Gi" />
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
                <div className="h-full rounded-full" style={{ width: `${totalBreakdownGi > 0 ? Math.max(10, Math.round((entry.totalGi / totalBreakdownGi) * 100)) : 0}%`, backgroundColor: entry.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </CollapsibleSection>
  );
}

function longhornBackups(backupVolumes: BackupVolume[], backupSummary: LonghornPanelProps["backupSummary"], backupData: BackupStatusResponse | undefined) {
  if (backupVolumes.length === 0) return null;
  return (
    <CollapsibleSection title="Backup status" count={backupSummary.total} storageKey="storage-backup-status">
      <div className="mb-4 grid gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Protected volumes</p><p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.total}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Longhorn backup volumes detected on the TrueNAS target.</p></div>
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Current backups</p><p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.healthy}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Recovered within the {backupData?.maxAgeHours ?? 36}h freshness window.</p></div>
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Stale backups</p><p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.stale}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Backups that are too old or ended in an error state.</p></div>
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4"><p className="text-xs uppercase tracking-[0.18em] text-slate-500">Missing backups</p><p className="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{backupSummary.missing}</p><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Volumes that have never produced a remote backup yet.</p></div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
            <tr><th className="px-4 py-3 text-left font-medium">Volume</th><th className="px-4 py-3 text-left font-medium">Status</th><th className="px-4 py-3 text-left font-medium">Last backup</th><th className="px-4 py-3 text-left font-medium">Age</th><th className="px-4 py-3 text-left font-medium">Count</th></tr>
          </thead>
          <tbody>
            {backupVolumes.map((volume) => (
              <tr key={volume.name} className="border-t border-[#1c1c1c] text-slate-700 dark:text-slate-300">
                <td className="px-4 py-4"><p className="font-medium text-gray-900 dark:text-white">{volume.name}</p><p className="mt-1 text-xs text-slate-500">{volume.lastBackupState ?? "No backup yet"}</p></td>
                <td className="px-4 py-4"><span className={cn("rounded-full px-2 py-1 text-xs font-medium", volume.status === "healthy" ? "bg-emerald-500/10 text-emerald-300" : volume.status === "stale" ? "bg-amber-500/10 text-amber-300" : "bg-red-500/10 text-red-300")}>{volume.status}</span></td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.lastBackupAt ? new Date(volume.lastBackupAt).toLocaleString() : "Never"}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{formatBackupAge(volume.ageHours)}</td>
                <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.backupCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleSection>
  );
}

function longhornVolumeList(props: { isLoading: boolean; filteredVolumes: Volume[]; sortBy: SortBy; setSortBy: (v: SortBy) => void; setSearch: (v: string) => void; setHealthFilter: (v: HealthFilter) => void; hasActiveFilters: boolean }) {
  const { isLoading, filteredVolumes, sortBy, setSortBy, setSearch, setHealthFilter, hasActiveFilters } = props;
  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] lg:block">
          <div className="h-12 border-b border-gray-200 dark:border-[#2a2a2a] bg-gray-100 dark:bg-white/5 animate-pulse" />
          {[...Array(6)].map((_, index) => <div key={index} className="h-16 border-b border-gray-200 dark:border-[#1a1a1a] bg-white/5/0 animate-pulse" />)}
        </div>
        <div className="grid gap-3 lg:hidden">
          {[...Array(4)].map((_, index) => <div key={index} className="h-28 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-100 dark:bg-white/5 animate-pulse" />)}
        </div>
      </div>
    );
  }
  if (filteredVolumes.length === 0) {
    return (
      <EmptyState
        icon={HardDrive}
        title={hasActiveFilters ? "No volumes match the current filters" : "No storage volumes found"}
        description={hasActiveFilters ? "Try clearing your search or broadening the health filter to bring volumes back into view." : "Longhorn did not return any volumes. Refresh this page after confirming the storage API is reachable."}
        action={hasActiveFilters ? { label: "Clear filters", onClick: () => { setSearch(""); setHealthFilter("all"); } } : undefined}
      />
    );
  }
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] lg:block">
        <table className="w-full text-sm">
          <thead className="bg-white dark:bg-[#0d0d0d] text-xs uppercase tracking-[0.16em] text-slate-500">
            <tr>
              {[["name", "Volume"], ["health", "Health"], ["replicas", "Replicas"], ["size", "Provisioned"], ["usage", "Usage"]].map(([value, label]) => (
                <th key={value} className="px-4 py-3 text-left font-medium">
                  <button type="button" onClick={() => setSortBy(value as SortBy)} className={cn("inline-flex items-center gap-1 transition-colors hover:text-gray-900 dark:hover:text-white", sortBy === value && "text-[#7cb9ff]")}>{label}<ArrowUpDown className="h-3 w-3" /></button>
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
                      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white dark:bg-[#0d0d0d] text-slate-500 dark:text-slate-400"><HardDrive className="h-4 w-4" /></div>
                      <div className="min-w-0"><p className="truncate font-medium text-gray-900 dark:text-white">{volume.name}</p><p className="mt-1 text-xs text-slate-500">{pct}% utilized</p></div>
                    </div>
                  </td>
                  <td className="px-4 py-4"><div className="flex items-center gap-2">{healthy ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertCircle className="h-4 w-4 text-amber-400" />}<span className={cn("rounded-full border px-2 py-1 text-xs font-medium", healthy ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : bucket === "critical" ? "border-red-500/30 bg-red-500/10 text-red-300" : "border-amber-500/30 bg-amber-500/10 text-amber-300")}>{volume.robustness}</span></div></td>
                  <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{volume.numberOfReplicas}x</td>
                  <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{formatBytes(volume.size ?? 0)}</td>
                  <td className="px-4 py-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400"><span>{formatBytes(volume.actualSize ?? 0)} used</span><span className={cn("font-medium", bucket === "critical" ? "text-red-300" : bucket === "attention" ? "text-amber-300" : "text-emerald-300")}>{pct}%</span></div>
                      <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]"><div className={cn("h-full rounded-full transition-all", bucket === "critical" ? "bg-red-500" : bucket === "attention" ? "bg-amber-500" : "bg-[#0078D4]")} style={{ width: `${pct}%` }} /></div>
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
                <div className="min-w-0"><div className="flex items-center gap-2"><HardDrive className="h-4 w-4 text-slate-500 dark:text-slate-400" /><span className="truncate text-sm font-medium text-gray-900 dark:text-white">{volume.name}</span></div><p className="mt-1 text-xs text-slate-500">{volume.numberOfReplicas} replicas</p></div>
                <div className="flex items-center gap-1.5">{healthy ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <AlertCircle className="h-4 w-4 text-amber-400" />}<span className={cn("text-xs font-medium", healthy ? "text-emerald-300" : bucket === "critical" ? "text-red-300" : "text-amber-300")}>{volume.robustness}</span></div>
              </div>
              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400"><span>{formatBytes(volume.actualSize ?? 0)} of {formatBytes(volume.size ?? 0)}</span><span className={cn("font-medium", bucket === "critical" ? "text-red-300" : bucket === "attention" ? "text-amber-300" : "text-emerald-300")}>{pct}%</span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white dark:bg-[#1a1a1a]"><div className={cn("h-full rounded-full transition-all", bucket === "critical" ? "bg-red-500" : bucket === "attention" ? "bg-amber-500" : "bg-[#0078D4]")} style={{ width: `${pct}%` }} /></div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </>
  );
}
