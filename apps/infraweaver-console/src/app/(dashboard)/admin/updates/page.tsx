"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle, GitBranch, Loader2, RefreshCw } from "lucide-react";
import { DataError } from "@/components/ui/data-error";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { StatusBadge } from "@/components/ui/status-badge";
import { useApiMutation, useApiQuery, useRBAC } from "@/hooks";
import { apiClient } from "@/lib/api-client";
import { cn, timeAgo } from "@/lib/utils";

interface UpdateItem {
  id: string;
  name: string;
  namespace: string;
  currentVersion: string;
  targetVersion?: string | null;
  chart: string | null;
  repoUrl: string | null;
  syncStatus: string;
  lastSync: string | null;
}

interface AvailableVersionsResponse {
  note?: string;
  source: "helm" | "docker" | "ghcr" | "unknown";
  versions: string[];
}

interface UpdateResponse {
  commitSha?: string;
  message: string;
  success: boolean;
}

interface UpdateCardProps {
  app: UpdateItem;
  canUpdate: boolean;
  isUpdating: boolean;
  selectedVersion: string;
  onSelectVersion: (appName: string, version: string) => void;
  onUpdate: (app: UpdateItem) => void;
}

function UpdateCard({ app, canUpdate, isUpdating, selectedVersion, onSelectVersion, onUpdate }: UpdateCardProps) {
  const [versionsEnabled, setVersionsEnabled] = useState(false);

  const versionsQuery = useQuery({
    queryKey: ["updates", "versions", app.name],
    queryFn: () => apiClient.get<AvailableVersionsResponse>(`/api/updates/${encodeURIComponent(app.name)}/versions`, { cache: "no-store" }),
    enabled: versionsEnabled,
    staleTime: 5 * 60 * 1000,
    retry: 0,
  });

  const options = useMemo(() => {
    const candidateVersions = [selectedVersion, app.targetVersion ?? undefined, app.currentVersion, ...(versionsQuery.data?.versions ?? [])];
    return Array.from(new Set(candidateVersions.filter((version): version is string => Boolean(version))));
  }, [app.currentVersion, app.targetVersion, selectedVersion, versionsQuery.data?.versions]);

  const disableUpdate = !canUpdate
    || isUpdating
    || !selectedVersion
    || selectedVersion === app.currentVersion
    || selectedVersion === app.targetVersion;

  const lastSyncLabel = app.lastSync ? timeAgo(app.lastSync) : "Unavailable";

  return (
    <article className="rounded-3xl border border-slate-200 bg-white/95 p-5 shadow-sm backdrop-blur dark:border-[#2a2a2a] dark:bg-[#111] dark:shadow-[0_20px_60px_rgba(0,0,0,0.2)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200/80 pb-4 dark:border-white/5">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-slate-950 dark:text-[#f2f2f2]">{app.name}</h2>
            <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-600 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#a3a3a3]">
              {app.namespace}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={app.syncStatus} label={app.syncStatus} size="sm" />
            {versionsEnabled && versionsQuery.data?.source ? (
              <span className="text-xs uppercase tracking-[0.2em] text-slate-400 dark:text-[#666]">
                {versionsQuery.data.source}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onUpdate(app)}
          disabled={disableUpdate}
          className={cn(
            "inline-flex min-h-[44px] items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
            disableUpdate
              ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 dark:border-white/10 dark:bg-white/5 dark:text-slate-500"
              : "border-indigo-500/30 bg-indigo-500/15 text-indigo-600 hover:bg-indigo-500/20 dark:text-indigo-300",
          )}
        >
          {isUpdating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
          {canUpdate ? "Update" : "Read only"}
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/5 dark:bg-white/5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-[#888]">Current version</p>
          <p className="mt-2 text-2xl font-semibold text-slate-950 dark:text-[#f2f2f2]">{app.currentVersion || "unknown"}</p>
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-[#888]">
            <GitBranch className="h-3.5 w-3.5" />
            Git target: {app.targetVersion ?? "unavailable"}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-white/5 dark:bg-white/5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-[#888]">Available versions</p>
          <select
            value={selectedVersion}
            onFocus={() => setVersionsEnabled(true)}
            onPointerDown={() => setVersionsEnabled(true)}
            onChange={(event) => onSelectVersion(app.name, event.target.value)}
            className="mt-2 min-h-[44px] w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition-colors focus:border-indigo-500/50 dark:border-white/10 dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
          >
            {options.length === 0 ? (
              <option value="">
                {versionsQuery.isLoading ? "Loading versions..." : "Versions unavailable"}
              </option>
            ) : null}
            {options.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
          <div className="mt-3 min-h-10 text-xs text-slate-500 dark:text-[#888]">
            {versionsQuery.isLoading ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading available versions...
              </span>
            ) : versionsQuery.data?.note ? (
              versionsQuery.data.note
            ) : options.length === 0 && versionsEnabled ? (
              "Version list unavailable."
            ) : (
              <span>
                {app.chart ?? "Custom source"}
                {app.repoUrl ? ` · ${app.repoUrl}` : ""}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-[#888]">
        <span>Last sync: {lastSyncLabel}</span>
        {app.lastSync ? <span>{new Date(app.lastSync).toLocaleString()}</span> : null}
      </div>
    </article>
  );
}

export default function UpdateManagerPage() {
  const { can } = useRBAC();
  const canUpdate = can("apps:write");
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});

  const updatesQuery = useApiQuery<UpdateItem[]>({
    queryKey: ["updates"],
    path: "/api/updates",
    staleTime: 30_000,
  });

  const updateMutation = useApiMutation<UpdateResponse, { appName: string; version: string }>({
    path: ({ appName }) => `/api/updates/${encodeURIComponent(appName)}`,
    method: "POST",
    request: ({ version }) => ({ json: { version } }),
    invalidateQueryKeys: [["updates"]],
    successMessage: (data) => data.message,
  });

  const apps = updatesQuery.data ?? [];

  useEffect(() => {
    if (!apps.length) {
      return;
    }

    setSelectedVersions((current) => {
      const next = { ...current };
      for (const app of apps) {
        if (!next[app.name]) {
          next[app.name] = app.targetVersion ?? app.currentVersion;
        }
      }
      return next;
    });
  }, [apps]);

  const summary = useMemo(() => {
    const total = apps.length;
    const outOfSync = apps.filter((app) => app.syncStatus.toLowerCase().includes("outofsync") || app.syncStatus.toLowerCase().includes("out of sync")).length;
    const progressing = apps.filter((app) => app.syncStatus.toLowerCase().includes("progress")).length;
    return { total, outOfSync, progressing };
  }, [apps]);

  const handleSelectVersion = (appName: string, version: string) => {
    setSelectedVersions((current) => ({
      ...current,
      [appName]: version,
    }));
  };

  const handleUpdate = (app: UpdateItem) => {
    const version = selectedVersions[app.name] ?? app.targetVersion ?? app.currentVersion;
    void updateMutation.mutateAsync({ appName: app.name, version });
  };

  return (
    <PageScaffold
      icon={ArrowUpCircle}
      title="Update Manager"
      description="Review GitOps chart targets, compare them with live ArgoCD state, and promote new versions safely."
      breadcrumb={[{ label: "Home", href: "/" }, { label: "Admin" }, { label: "Update Manager" }]}
      loading={updatesQuery.isLoading}
      actions={
        <button
          type="button"
          onClick={() => void updatesQuery.refetch()}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-950 dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#d4d4d4] dark:hover:bg-[#161616] dark:hover:text-[#f2f2f2]"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      }
      isEmpty={!updatesQuery.isLoading && apps.length === 0}
      emptyState={{
        icon: ArrowUpCircle,
        title: "No managed applications found",
        description: "No kubernetes/*/application.yaml manifests were discovered for update management.",
      }}
    >
      {updatesQuery.isError ? (
        <DataError
          message="Update inventory unavailable"
          detail={updatesQuery.error?.message}
          onRetry={() => void updatesQuery.refetch()}
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { label: "Managed apps", value: summary.total },
              { label: "Out of sync", value: summary.outOfSync },
              { label: "Progressing", value: summary.progressing },
            ].map((item) => (
              <div key={item.label} className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm dark:border-[#2a2a2a] dark:bg-[#111]">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-[#888]">{item.label}</p>
                <p className="mt-2 text-3xl font-semibold text-slate-950 dark:text-[#f2f2f2]">{item.value}</p>
              </div>
            ))}
          </div>

          {!canUpdate ? (
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              You have read-only access. Version discovery is available, but updates require the <code className="font-mono">apps:write</code> permission.
            </div>
          ) : null}

          <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            {apps.map((app) => (
              <UpdateCard
                key={app.id}
                app={app}
                canUpdate={canUpdate}
                isUpdating={updateMutation.isPending && updateMutation.variables?.appName === app.name}
                selectedVersion={selectedVersions[app.name] ?? app.targetVersion ?? app.currentVersion}
                onSelectVersion={handleSelectVersion}
                onUpdate={handleUpdate}
              />
            ))}
          </div>
        </div>
      )}
    </PageScaffold>
  );
}
