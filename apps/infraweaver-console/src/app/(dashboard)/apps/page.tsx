"use client";
import React, { useState, useMemo } from "react";
import { useArgoApps } from "@/hooks/use-argocd";
import { PageHeader } from "@/components/ui/page-header";
import { CommandBar } from "@/components/ui/command-bar";
import { ResourceTable } from "@/components/ui/resource-table";
import { SectionTabs } from "@/components/ui/section-tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { Layers, RefreshCw, Search } from "lucide-react";
import type { Column } from "@/components/ui/resource-table";

type AppHealthStatus = "healthy" | "degraded" | "syncing" | "progressing" | "unknown" | "synced" | "outOfSync";

interface AppRow {
  name: string;
  namespace: string;
  health: AppHealthStatus;
  syncStatus: AppHealthStatus;
  project: string;
  [key: string]: unknown;
}

function toHealthStatus(val: string): AppHealthStatus {
  const v = val.toLowerCase();
  const MAP: Record<string, AppHealthStatus> = {
    healthy: "healthy",
    degraded: "degraded",
    progressing: "progressing",
    syncing: "syncing",
    synced: "synced",
    outofsync: "outOfSync",
    unknown: "unknown",
  };
  return MAP[v] ?? "unknown";
}

const TABS = [
  { label: "All", value: "all" },
  { label: "Healthy", value: "healthy" },
  { label: "Degraded", value: "degraded" },
  { label: "Syncing", value: "syncing" },
  { label: "OutOfSync", value: "outofsync" },
];

export default function AppsPage() {
  const { data: apps, isLoading: loading, refetch } = useArgoApps();
  const [activeTab, setActiveTab] = useState("all");
  const [search, setSearch] = useState("");

  const rows: AppRow[] = useMemo(() => {
    if (!apps) return [];
    return apps.map(app => ({
      name: app.metadata?.name ?? "",
      namespace: app.spec?.destination?.namespace ?? "",
      health: toHealthStatus(app.status?.health?.status ?? "Unknown"),
      syncStatus: toHealthStatus(app.status?.sync?.status ?? "Unknown"),
      project: app.spec?.project ?? "default",
    }));
  }, [apps]);

  const filtered = useMemo(() => {
    let result = rows;
    if (activeTab !== "all") {
      result = result.filter(r =>
        activeTab === "outofsync"
          ? r.syncStatus === "outOfSync"
          : r.health === activeTab || r.syncStatus === activeTab
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(r => r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q));
    }
    return result;
  }, [rows, activeTab, search]);

  const tabsWithCounts = TABS.map(t => ({
    ...t,
    badge: t.value === "all" ? rows.length : rows.filter(r =>
      t.value === "outofsync"
        ? r.syncStatus === "outOfSync"
        : r.health === t.value || r.syncStatus === t.value
    ).length,
  }));

  const columns: Column<AppRow>[] = [
    { key: "name", label: "Name", sortable: true, render: row => <span className="font-medium text-[#f2f2f2]">{row.name}</span> },
    { key: "namespace", label: "Namespace", sortable: true, render: row => <span className="text-[#9e9e9e] font-mono text-xs">{row.namespace}</span> },
    { key: "health", label: "Health", render: row => <StatusBadge status={row.health} /> },
    { key: "syncStatus", label: "Sync", render: row => <StatusBadge status={row.syncStatus} /> },
    { key: "project", label: "Project", sortable: true },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader title="Applications" icon={Layers} subtitle={`${rows.length} ArgoCD applications`} />
      <CommandBar
        actions={[
          { label: "Refresh", icon: RefreshCw, onClick: () => void refetch() },
        ]}
        search={
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="bg-[#0f0f0f] border border-[#333] rounded pl-8 pr-3 py-1.5 text-xs text-[#f2f2f2] placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50 w-56"
            />
          </div>
        }
      />
      <SectionTabs tabs={tabsWithCounts} activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 overflow-auto p-4">
        <ResourceTable
          columns={columns}
          data={filtered}
          loading={loading}
          getRowKey={row => row.name}
          empty={<EmptyState icon={Layers} title="No applications" description="No ArgoCD applications found" />}
          mobileCardRender={row => (
            <React.Fragment>
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-[#f2f2f2] text-sm">{row.name}</span>
                <StatusBadge status={row.health} />
              </div>
              <div className="text-xs text-[#9e9e9e]">{row.namespace} · {row.project}</div>
            </React.Fragment>
          )}
        />
      </div>
    </div>
  );
}
