"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { EmptyState, PageScaffold } from "@/components/ui";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";

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

export default function SecretsPage() {
  const { can } = useRBAC();
  const canViewSecrets = can("cluster:admin");
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");

  const { data, isLoading, isFetching, refetch } = useQuery<SecretsResponse>({
    queryKey: ["secrets-browser"],
    queryFn: async () => {
      const response = await fetch("/api/secrets", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load secrets");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: canViewSecrets,
  });

  const secrets = useMemo(() => data?.secrets ?? [], [data?.secrets]);
  const namespaces = useMemo(() => Array.from(new Set(secrets.map((secret) => secret.namespace))).sort(), [secrets]);
  const types = useMemo(() => Array.from(new Set(secrets.map((secret) => secret.type))).sort(), [secrets]);

  const filteredSecrets = useMemo(() => {
    const query = search.trim().toLowerCase();
    return secrets.filter((secret) => {
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
  }, [namespaceFilter, search, secrets, typeFilter]);

  const managedCount = secrets.filter((secret) => secret.externalSecret).length;

  if (!canViewSecrets) {
    return (
      <PageScaffold icon={KeyRound} title="Secrets" description="Read-only secret inventory with ExternalSecret ownership.">
        <EmptyState
          icon={ShieldAlert}
          title="Cluster admin permission required"
          description="Secret metadata is restricted to cluster:admin. Values are never returned by the API."
        />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      icon={KeyRound}
      title="Secrets"
      description="Read-only browser for Kubernetes secrets, key names, and ExternalSecret ownership. Values are never shown."
      actions={
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Refresh
        </button>
      }
      loading={isLoading}
      isEmpty={!isLoading && filteredSecrets.length === 0}
      emptyState={{
        icon: KeyRound,
        title: secrets.length === 0 ? "No secrets found" : "No secrets matched",
        description: secrets.length === 0
          ? "The selected cluster scope did not return any secrets."
          : "Try a different namespace, secret type, or search term.",
      }}
    >
      <div className="space-y-6">
        {data?.live === false ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Live Kubernetes data is unavailable, so the console is showing safe mock secret metadata for UI validation.
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Secrets</p>
            <p className="mt-2 text-3xl font-semibold text-white">{secrets.length}</p>
          </div>
          <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-indigo-100/80">Namespaces</p>
            <p className="mt-2 text-3xl font-semibold text-indigo-200">{namespaces.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">ExternalSecrets</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-200">{managedCount}</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Keys tracked</p>
            <p className="mt-2 text-3xl font-semibold text-cyan-200">{secrets.reduce((count, secret) => count + secret.keyCount, 0)}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search by name, namespace, type, ExternalSecret, or key name…"
                className="w-full rounded-xl border border-white/10 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-500/50"
              />
            </div>
            <select
              value={namespaceFilter}
              onChange={(event) => setNamespaceFilter(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
            >
              <option value="all">All namespaces</option>
              {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
            </select>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
            >
              <option value="all">All types</option>
              {types.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Namespace</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">ExternalSecret</th>
                  <th className="px-4 py-3">Keys</th>
                  <th className="px-4 py-3">Age</th>
                </tr>
              </thead>
              <tbody>
                {filteredSecrets.map((secret) => (
                  <tr key={`${secret.namespace}/${secret.name}`} className="border-t border-white/5 align-top">
                    <td className="px-4 py-4">
                      <p className="font-medium text-white">{secret.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{secret.keyCount} key{secret.keyCount === 1 ? "" : "s"}</p>
                    </td>
                    <td className="px-4 py-4 text-slate-300">{secret.namespace}</td>
                    <td className="px-4 py-4">
                      <span className="rounded-full border border-white/10 bg-slate-950 px-2.5 py-1 text-xs text-slate-300">{secret.type}</span>
                    </td>
                    <td className="px-4 py-4 text-slate-300">{secret.externalSecret ?? "—"}</td>
                    <td className="px-4 py-4">
                      <div className="flex max-w-md flex-wrap gap-1.5">
                        {secret.keyNames.length > 0 ? secret.keyNames.map((keyName) => (
                          <span key={keyName} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200">{keyName}</span>
                        )) : <span className="text-slate-500">No keys</span>}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-slate-400">{secret.age ? timeAgo(secret.age) : "Unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </PageScaffold>
  );
}
