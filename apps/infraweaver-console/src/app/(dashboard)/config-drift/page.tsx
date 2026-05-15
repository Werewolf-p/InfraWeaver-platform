"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Database, Lock, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { DataCard } from "@/components/ui/data-card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResourceBar } from "@/components/ui/resource-bar";
import { ResourceTable, type Column } from "@/components/ui/resource-table";
import { SearchInput } from "@/components/ui/search-input";
import { StatusBadge } from "@/components/ui/status-badge";
import { useConfigDrift } from "@/hooks/use-config-drift";
import { useDebounce } from "@/hooks/use-debounce";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { usePermissions } from "@/hooks/use-permissions";
import { useRefetchInterval } from "@/hooks/use-refetch-interval";
import type { ConfigDriftEntry } from "@/types/cluster";

export default function ConfigDriftPage() {
  const { can, canAny } = usePermissions();
  const canViewDrift = canAny(["cluster:read", "infra:read"]);
  const canManageDrift = can("cluster:admin");
  const [search, setSearch] = useLocalStorage("config-drift-search", "");
  const debouncedSearch = useDebounce(search, 200);
  const { drift, baselineCaptured, isLoading, refetch, captureBaseline, clearBaseline } = useConfigDrift();

  useRefetchInterval(() => refetch(), 60_000, canViewDrift);

  const driftedEntries = drift.filter((entry) => entry.drifted);
  const filteredEntries = useMemo(() => {
    const query = debouncedSearch.trim().toLowerCase();
    if (!query) return drift;

    return drift.filter((entry) =>
      [entry.name, entry.namespace, entry.kind, entry.image, entry.currentImage].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [debouncedSearch, drift]);

  const columns: Column<ConfigDriftEntry>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Name",
        sortable: true,
        render: (entry) => (
          <div>
            <p className="font-medium text-white">{entry.name}</p>
            <p className="text-xs text-slate-500">{entry.kind}</p>
          </div>
        ),
      },
      {
        key: "namespace",
        label: "Namespace",
        sortable: true,
        render: (entry) => <span className="text-sm text-slate-400">{entry.namespace}</span>,
      },
      {
        key: "drifted",
        label: "Status",
        sortable: true,
        render: (entry) => (
          <StatusBadge
            status={entry.drifted ? "outOfSync" : "synced"}
            label={entry.drifted ? "Drifted" : "In Sync"}
            size="sm"
          />
        ),
      },
      {
        key: "image",
        label: "Baseline Image",
        render: (entry) => <span className="font-mono text-xs text-slate-300">{entry.image}</span>,
      },
      {
        key: "currentImage",
        label: "Current Image",
        render: (entry) => (
          <span className={entry.drifted ? "font-mono text-xs text-red-400" : "font-mono text-xs text-slate-300"}>
            {entry.currentImage}
          </span>
        ),
      },
      {
        key: "replicas",
        label: "Replicas",
        sortable: true,
        render: (entry) => (
          <span className={entry.replicas !== entry.currentReplicas ? "text-sm text-red-400" : "text-sm text-slate-300"}>
            {entry.replicas} → {entry.currentReplicas}
          </span>
        ),
      },
    ],
    [],
  );

  if (!canViewDrift) {
    return (
      <EmptyState
        icon={Lock}
        title="Config drift is restricted"
        description="You do not have permission to inspect baseline drift for cluster workloads."
      />
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={AlertTriangle}
        title="Config Drift"
        description="Compare current workload state against the saved baseline"
        badge={baselineCaptured ? "Baseline active" : "Baseline missing"}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => captureBaseline.mutate()}
              disabled={captureBaseline.isPending || !canManageDrift}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-300 transition-colors hover:bg-indigo-500/20 disabled:opacity-50"
            >
              <Database className="h-4 w-4" />
              {captureBaseline.isPending ? "Capturing..." : baselineCaptured ? "Refresh Baseline" : "Capture Baseline"}
            </button>
            {baselineCaptured ? (
              <button
                type="button"
                onClick={() => clearBaseline.mutate()}
                disabled={clearBaseline.isPending || !canManageDrift}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Clear Baseline
              </button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-3 md:grid-cols-3">
        <DataCard title="Tracked Workloads" value={drift.length} subtitle="Resources currently compared" />
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <DataCard title="Drifted" value={driftedEntries.length} subtitle="Resources requiring attention" trend={driftedEntries.length > 0 ? "down" : undefined} className="border-0 bg-transparent p-0" />
          <ResourceBar value={driftedEntries.length} max={drift.length || 1} label="Drift share" valueFormatter={(_, __, percentage) => `${percentage}%`} tone={driftedEntries.length > 0 ? "red" : "emerald"} className="mt-4" />
        </div>
        <DataCard title="Baseline" value={baselineCaptured ? "Ready" : "Missing"} subtitle="Saved comparison source" trend={baselineCaptured ? "up" : "down"} />
      </div>

      {!baselineCaptured ? (
        <EmptyState
          icon={Database}
          title="No baseline captured yet"
          description="Capture a baseline once, then compare live workloads against that known-good state."
          action={canManageDrift ? { label: "Capture baseline", onClick: () => captureBaseline.mutate() } : undefined}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput placeholder="Search names, namespaces, kinds, or images" value={search} onChange={setSearch} className="sm:max-w-md" />
            <p className="text-sm text-slate-500">Showing {filteredEntries.length} of {drift.length} workloads</p>
          </div>

          <ResourceTable
            tableId="config-drift-workloads"
            caption="Config drift workloads table"
            columns={columns}
            data={filteredEntries}
            loading={isLoading}
            getRowKey={(entry) => `${entry.namespace}/${entry.name}`}
            empty={
              <EmptyState
                icon={AlertTriangle}
                title={drift.length === 0 ? "No workloads captured" : "No workloads match your search"}
                description={
                  drift.length === 0
                    ? "Capture a baseline again to refresh the tracked workload list."
                    : "Try a different filter to inspect drift in another namespace or workload."
                }
              />
            }
            mobileCardRender={(entry) => (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-white">{entry.name}</p>
                    <p className="text-xs text-slate-500">{entry.namespace} · {entry.kind}</p>
                  </div>
                  <StatusBadge
                    status={entry.drifted ? "outOfSync" : "synced"}
                    label={entry.drifted ? "Drifted" : "In Sync"}
                    size="sm"
                  />
                </div>
                <div className="space-y-1 text-xs text-slate-400">
                  <p><span className="text-slate-500">Baseline:</span> <span className="font-mono">{entry.image}</span></p>
                  <p><span className="text-slate-500">Current:</span> <span className={entry.drifted ? "font-mono text-red-400" : "font-mono"}>{entry.currentImage}</span></p>
                  <p><span className="text-slate-500">Replicas:</span> {entry.replicas} → {entry.currentReplicas}</p>
                </div>
              </div>
            )}
          />
        </>
      )}
    </motion.div>
  );
}
