"use client";

import { useMemo, useState } from "react";
import { FileText, Save, ShieldAlert, Trash2 } from "lucide-react";
import { ConfirmDialog, DashboardStatCard, EmptyState, FilterSelect, KubeOfflineBanner, PageScaffold, RefreshButton, RelativeTime, SearchInput, SingleClusterGuard } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";

interface ConfigMapItem {
  name: string;
  namespace: string;
  age: string | null;
  immutable: boolean;
  keys: string[];
  binaryKeys: string[];
  data: Record<string, string>;
}

interface ConfigMapsResponse {
  configMaps: ConfigMapItem[];
  live?: boolean;
}

function configMapId(configMap: Pick<ConfigMapItem, "namespace" | "name">) {
  return `${configMap.namespace}/${configMap.name}`;
}

function hasDraftChanges(current: Record<string, string>, draft: Record<string, string>) {
  const currentKeys = Object.keys(current);
  const draftKeys = Object.keys(draft);
  if (currentKeys.length !== draftKeys.length) return true;
  return currentKeys.some((key) => current[key] !== draft[key]);
}

export function ConfigMapsView() {
  const { can } = useRBAC();
  const canManageConfigMaps = can("cluster:admin");
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [deleteTarget, setDeleteTarget] = useState<ConfigMapItem | null>(null);
  const [removedConfigMaps, setRemovedConfigMaps] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, refetch, isError, error } = useApiQuery<ConfigMapsResponse>({
    queryKey: ["config-maps"],
    path: "/api/config-maps",
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: canManageConfigMaps,
  });

  const deleteMutation = useApiMutation<{ ok: boolean; simulated?: boolean }, { namespace: string; name: string }>({
    path: "/api/config-maps",
    method: "DELETE",
    request: (vars) => ({ json: vars }),
    successMessage: (payload, vars) => payload.simulated ? `Deleted ${vars.name} (simulated)` : `Deleted ${vars.name}`,
    invalidateQueryKeys: [["config-maps"]],
    onSuccess: (_, vars) => {
      setRemovedConfigMaps((current) => {
        const next = new Set(current);
        next.add(configMapId(vars));
        return next;
      });
      setDeleteTarget(null);
      setDrafts((current) => {
        const next = { ...current };
        delete next[configMapId(vars)];
        return next;
      });
    },
  });

  const saveMutation = useApiMutation<{ simulated?: boolean }, { namespace: string; name: string; data: Record<string, string> }>({
    path: "/api/config-maps",
    method: "PATCH",
    successMessage: (payload, vars) => payload.simulated ? `Saved ${vars.name} (simulated)` : `Saved ${vars.name}`,
    invalidateQueryKeys: [["config-maps"]],
  });
  const savingId = saveMutation.isPending && saveMutation.variables ? configMapId(saveMutation.variables) : null;

  const configMaps = useMemo(() => data?.configMaps ?? [], [data?.configMaps]);
  const visibleConfigMaps = useMemo(
    () => configMaps.filter((configMap) => !removedConfigMaps.has(configMapId(configMap))),
    [configMaps, removedConfigMaps],
  );

  const namespaces = useMemo(
    () => Array.from(new Set(visibleConfigMaps.map((configMap) => configMap.namespace))).sort(),
    [visibleConfigMaps],
  );

  const filteredConfigMaps = useMemo(() => {
    const query = search.trim().toLowerCase();
    return visibleConfigMaps.filter((configMap) => {
      const matchesNamespace = namespaceFilter === "all" || configMap.namespace === namespaceFilter;
      const matchesSearch = !query
        || configMap.name.toLowerCase().includes(query)
        || configMap.namespace.toLowerCase().includes(query)
        || configMap.keys.some((key) => key.toLowerCase().includes(query));
      return matchesNamespace && matchesSearch;
    });
  }, [namespaceFilter, search, visibleConfigMaps]);

  if (!canManageConfigMaps) {
    return (
      <SingleClusterGuard>
        <PageScaffold icon={FileText} title="Config Maps" description="Cluster-wide ConfigMap editor for platform operators.">
          <EmptyState
            icon={ShieldAlert}
            title="Cluster admin permission required"
            description="This editor requires cluster:admin because the current RBAC model does not define infra:write."
          />
        </PageScaffold>
      </SingleClusterGuard>
    );
  }

  return (
    <SingleClusterGuard>
      <PageScaffold
        icon={FileText}
        title="Config Maps"
        description="Review cluster ConfigMaps and edit data values inline without leaving the console."
        actions={<RefreshButton onClick={() => void refetch()} refreshing={isFetching} />}
        loading={isLoading}
        isEmpty={!isLoading && !isError && filteredConfigMaps.length === 0}
        isError={isError}
        errorDetail={error?.message}
        emptyState={{
          icon: FileText,
          title: visibleConfigMaps.length === 0 ? "No ConfigMaps found" : "No ConfigMaps matched",
          description: visibleConfigMaps.length === 0
            ? "The console could not find any ConfigMaps in the selected scope."
            : "Try a different namespace or clear the search to see more ConfigMaps.",
        }}
      >
        <div className="space-y-6">
          <KubeOfflineBanner
            show={data?.live === false}
            resource="ConfigMap data"
            hint="Check cluster connectivity and service account permissions."
          />

          <div className="grid gap-4 md:grid-cols-3">
            <DashboardStatCard label="ConfigMaps" value={visibleConfigMaps.length} />
            <DashboardStatCard label="Namespaces" value={namespaces.length} tone="info" />
            <DashboardStatCard label="Editable keys" value={visibleConfigMaps.reduce((count, item) => count + item.keys.length, 0)} tone="success" />
          </div>

          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search ConfigMap name, namespace, or key…"
                className="flex-1"
              />
              <FilterSelect
                label="Filter by namespace"
                value={namespaceFilter}
                onChange={setNamespaceFilter}
                options={[{ value: "all", label: "All namespaces" }, ...namespaces]}
              />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            {filteredConfigMaps.map((configMap) => {
              const id = configMapId(configMap);
              const draft = drafts[id] ?? configMap.data;
              const dirty = hasDraftChanges(configMap.data, draft);
              const isDeleting = deleteMutation.isPending && deleteTarget != null && configMapId(deleteTarget) === id;
              return (
                <div key={id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{configMap.name}</h2>
                        <span className="rounded-full border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300">{configMap.namespace}</span>
                        {configMap.immutable ? (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">Immutable</span>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                        <RelativeTime date={configMap.age} />
                        <span>·</span>
                        <span>
                          {configMap.keys.length} key{configMap.keys.length === 1 ? "" : "s"}
                          {configMap.binaryKeys.length > 0 ? ` · ${configMap.binaryKeys.length} binary key${configMap.binaryKeys.length === 1 ? "" : "s"}` : ""}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => saveMutation.mutate({ namespace: configMap.namespace, name: configMap.name, data: draft })}
                        disabled={!dirty || configMap.immutable || savingId === id}
                        className="inline-flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm font-medium text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Save className="h-4 w-4" />
                        {savingId === id ? "Saving…" : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(configMap)}
                        disabled={isDeleting}
                        className="inline-flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>

                  {configMap.binaryKeys.length > 0 ? (
                    <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
                      Binary keys are preserved during PATCH but are not editable here: {configMap.binaryKeys.join(", ")}
                    </div>
                  ) : null}

                  <div className="mt-4 space-y-4">
                    {configMap.keys.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/50 px-4 py-8 text-center text-sm text-slate-500">
                        This ConfigMap has no text data keys to edit.
                      </div>
                    ) : (
                      configMap.keys.map((key) => (
                        <label key={key} className="block">
                          <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-gray-900 dark:text-white">{key}</span>
                            <span className="text-xs text-slate-500">{draft[key]?.length ?? 0} chars</span>
                          </div>
                          <textarea
                            value={draft[key] ?? ""}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDrafts((current) => ({
                                ...current,
                                [id]: {
                                  ...(current[id] ?? configMap.data),
                                  [key]: value,
                                },
                              }));
                            }}
                            rows={Math.min(12, Math.max(4, (draft[key] ?? "").split("\n").length + 1))}
                            className="min-h-[132px] w-full rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 font-mono text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
                          />
                        </label>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </PageScaffold>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onConfirm={() => deleteTarget ? deleteMutation.mutate({ namespace: deleteTarget.namespace, name: deleteTarget.name }) : undefined}
        onCancel={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete ConfigMap ${deleteTarget.name}?` : "Delete ConfigMap?"}
        description="This permanently removes the ConfigMap from the cluster. Applications depending on it may need to be restarted or reconciled."
        confirmText={deleteMutation.isPending ? "Deleting…" : "Delete ConfigMap"}
        danger
        requireTyping={deleteTarget?.name}
      />
    </SingleClusterGuard>
  );
}
