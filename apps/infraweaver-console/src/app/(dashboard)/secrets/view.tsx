"use client";

import { useMemo, useState } from "react";
import { KeyRound, ShieldAlert, Trash2 } from "lucide-react";
import { ConfirmDialog, DashboardStatCard, EmptyState, FilterSelect, KubeOfflineBanner, PageScaffold, RefreshButton, RelativeTime, SearchInput, SingleClusterGuard } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";

interface SecretItem {
  name: string;
  namespace: string;
  type: string;
  age: string | null;
  keyCount: number;
  keyNames: string[];
  externalSecret: string | null;
}

interface SecretsResponse {
  secrets: SecretItem[];
  live?: boolean;
}

function secretId(secret: Pick<SecretItem, "namespace" | "name">) {
  return `${secret.namespace}/${secret.name}`;
}

export function SecretsView() {
  const { can } = useRBAC();
  const canViewSecrets = can("cluster:admin");
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<SecretItem | null>(null);
  const [removedSecrets, setRemovedSecrets] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, refetch, isError, error } = useApiQuery<SecretsResponse>({
    queryKey: ["secrets-browser"],
    path: "/api/secrets",
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: canViewSecrets,
  });

  const deleteMutation = useApiMutation<{ ok: boolean; simulated?: boolean }, { namespace: string; name: string }>({
    path: "/api/secrets",
    method: "DELETE",
    request: (vars) => ({ json: vars }),
    successMessage: (payload, vars) => payload.simulated ? `Deleted ${vars.name} (simulated)` : `Deleted ${vars.name}`,
    invalidateQueryKeys: [["secrets-browser"]],
    onSuccess: (_, vars) => {
      setRemovedSecrets((current) => {
        const next = new Set(current);
        next.add(secretId(vars));
        return next;
      });
      setDeleteTarget(null);
    },
  });

  const secrets = useMemo(() => data?.secrets ?? [], [data?.secrets]);
  const visibleSecrets = useMemo(
    () => secrets.filter((secret) => !removedSecrets.has(secretId(secret))),
    [removedSecrets, secrets],
  );
  const namespaces = useMemo(() => Array.from(new Set(visibleSecrets.map((secret) => secret.namespace))).sort(), [visibleSecrets]);
  const types = useMemo(() => Array.from(new Set(visibleSecrets.map((secret) => secret.type))).sort(), [visibleSecrets]);

  const filteredSecrets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return visibleSecrets.filter((secret) => {
      const matchesNamespace = namespaceFilter === "all" || secret.namespace === namespaceFilter;
      const matchesType = typeFilter === "all" || secret.type === typeFilter;
      const matchesSearch = !query
        || secret.name.toLowerCase().includes(query)
        || secret.namespace.toLowerCase().includes(query)
        || secret.type.toLowerCase().includes(query)
        || secret.keyNames.some((key) => key.toLowerCase().includes(query))
        || (secret.externalSecret ?? "").toLowerCase().includes(query);
      return matchesNamespace && matchesType && matchesSearch;
    });
  }, [namespaceFilter, search, typeFilter, visibleSecrets]);

  const managedCount = visibleSecrets.filter((secret) => secret.externalSecret).length;

  if (!canViewSecrets) {
    return (
      <SingleClusterGuard>
        <PageScaffold icon={KeyRound} title="Secrets" description="Read-only secret inventory with ExternalSecret ownership.">
          <EmptyState
            icon={ShieldAlert}
            title="Cluster admin permission required"
            description="Secret metadata is restricted to cluster:admin. Values are never returned by the API."
          />
        </PageScaffold>
      </SingleClusterGuard>
    );
  }

  return (
    <SingleClusterGuard>
      <PageScaffold
        icon={KeyRound}
        title="Secrets"
        description="Read-only browser for Kubernetes secrets, key names, and ExternalSecret ownership. Values are never shown."
        actions={<RefreshButton onClick={() => void refetch()} refreshing={isFetching} />}
        loading={isLoading}
        isEmpty={!isLoading && !isError && filteredSecrets.length === 0}
        isError={isError}
        errorDetail={error?.message}
        emptyState={{
          icon: KeyRound,
          title: visibleSecrets.length === 0 ? "No secrets found" : "No secrets matched",
          description: visibleSecrets.length === 0
            ? "The selected cluster scope did not return any secrets."
            : "Try a different namespace, secret type, or search term.",
        }}
      >
        <div className="space-y-6">
          <KubeOfflineBanner
            show={data?.live === false}
            resource="secret data"
            hint="Check cluster connectivity and service account permissions."
          />

          <div className="grid gap-4 md:grid-cols-4">
            <DashboardStatCard label="Secrets" value={visibleSecrets.length} />
            <DashboardStatCard label="Namespaces" value={namespaces.length} tone="info" />
            <DashboardStatCard label="ExternalSecrets" value={managedCount} tone="success" />
            <DashboardStatCard label="Keys tracked" value={visibleSecrets.reduce((count, secret) => count + secret.keyCount, 0)} tone="info" />
          </div>

          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search by name, namespace, type, ExternalSecret, or key name…"
                className="flex-1"
              />
              <FilterSelect
                label="Filter by namespace"
                value={namespaceFilter}
                onChange={setNamespaceFilter}
                options={[{ value: "all", label: "All namespaces" }, ...namespaces]}
              />
              <FilterSelect
                label="Filter by type"
                value={typeFilter}
                onChange={setTypeFilter}
                options={[{ value: "all", label: "All types" }, ...types]}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="bg-slate-100 dark:bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Namespace</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">ExternalSecret</th>
                    <th className="px-4 py-3">Keys</th>
                    <th className="px-4 py-3">Age</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSecrets.map((secret) => {
                    const isDeleting = deleteMutation.isPending && deleteTarget != null && secretId(deleteTarget) === secretId(secret);
                    return (
                      <tr key={secretId(secret)} className="border-t border-gray-200 dark:border-white/5 align-top">
                        <td className="px-4 py-4">
                          <p className="font-medium text-gray-900 dark:text-white">{secret.name}</p>
                          <p className="mt-1 text-xs text-slate-500">{secret.keyCount} key{secret.keyCount === 1 ? "" : "s"}</p>
                        </td>
                        <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{secret.namespace}</td>
                        <td className="px-4 py-4">
                          <span className="rounded-full border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300">{secret.type}</span>
                        </td>
                        <td className="px-4 py-4 text-slate-700 dark:text-slate-300">{secret.externalSecret ?? "—"}</td>
                        <td className="px-4 py-4">
                          <div className="flex max-w-md flex-wrap gap-1.5">
                            {secret.keyNames.length > 0 ? secret.keyNames.map((keyName) => (
                              <span key={keyName} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200">{keyName}</span>
                            )) : <span className="text-slate-500">No keys</span>}
                          </div>
                        </td>
                        <td className="px-4 py-4 text-slate-500 dark:text-slate-400"><RelativeTime date={secret.age} /></td>
                        <td className="px-4 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(secret)}
                            disabled={isDeleting}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {isDeleting ? "Deleting…" : "Delete"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </PageScaffold>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onConfirm={() => deleteTarget ? deleteMutation.mutate({ namespace: deleteTarget.namespace, name: deleteTarget.name }) : undefined}
        onCancel={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete secret ${deleteTarget.name}?` : "Delete secret?"}
        description="This removes the Kubernetes secret immediately. ExternalSecret controllers may recreate managed secrets."
        confirmText={deleteMutation.isPending ? "Deleting…" : "Delete secret"}
        danger
        requireTyping={deleteTarget?.name}
      />
    </SingleClusterGuard>
  );
}
