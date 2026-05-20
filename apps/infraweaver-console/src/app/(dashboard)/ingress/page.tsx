"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Globe, RefreshCw, Search } from "lucide-react";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { PageHeader } from "@/components/ui/page-header";
import { accessTierTabs, type AccessTier } from "@/lib/access-tier";
import { cn } from "@/lib/utils";

interface IngressRoute {
  id: string;
  namespace: string;
  name: string;
  entryPoints: string[];
  hosts: string[];
  services: string[];
  middlewares: string[];
  authMiddlewares: string[];
  accessTier: AccessTier;
  tlsSecretName: string | null;
  certResolver: string | null;
  hasTls: boolean;
}

interface IngressResponse {
  ingressRoutes: IngressRoute[];
  live: boolean;
  summary: { total: number; authProtected: number; tlsEnabled: number; hosts: number };
}

export default function IngressPage() {
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [authFilter, setAuthFilter] = useState<"all" | "auth" | "public">("all");
  const [tlsFilter, setTlsFilter] = useState<"all" | "tls" | "plain">("all");
  const [accessTierFilter, setAccessTierFilter] = useState<"all" | AccessTier>("all");

  const { data, isLoading, isFetching, refetch } = useQuery<IngressResponse>({
    queryKey: ["ingress-routes"],
    queryFn: async () => {
      const response = await fetch("/api/ingress", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch ingress routes");
      return response.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const routes = useMemo(() => data?.ingressRoutes ?? [], [data?.ingressRoutes]);
  const namespaces = useMemo(() => Array.from(new Set(routes.map((route) => route.namespace))).sort(), [routes]);
  const filtered = useMemo(() => routes.filter((route) => {
    const query = search.trim().toLowerCase();
    const haystack = [route.name, route.namespace, route.hosts.join(" "), route.services.join(" "), route.middlewares.join(" ")].join(" ").toLowerCase();
    const matchesSearch = !query || haystack.includes(query);
    const matchesNamespace = namespaceFilter === "all" || route.namespace === namespaceFilter;
    const matchesAuth = authFilter === "all"
      || (authFilter === "auth" && route.authMiddlewares.length > 0)
      || (authFilter === "public" && route.authMiddlewares.length === 0);
    const matchesTls = tlsFilter === "all"
      || (tlsFilter === "tls" && route.hasTls)
      || (tlsFilter === "plain" && !route.hasTls);
    const matchesAccessTier = accessTierFilter === "all" || route.accessTier === accessTierFilter;
    return matchesSearch && matchesNamespace && matchesAuth && matchesTls && matchesAccessTier;
  }), [accessTierFilter, authFilter, namespaceFilter, routes, search, tlsFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Ingress"
        subtitle="Traefik IngressRoute audit for hosts, auth middleware, backends, and TLS"
        badge={data?.live === false ? "offline" : "live"}
        actions={
          <button
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </button>
        }
      />

      {data?.live === false ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Kubernetes unavailable — IngressRoute data cannot be loaded. Check Traefik and cluster connectivity.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">IngressRoutes</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900 dark:text-white">{data?.summary.total ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-indigo-100/80">Hosts</p>
          <p className="mt-2 text-3xl font-semibold text-indigo-200">{data?.summary.hosts ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">TLS enabled</p>
          <p className="mt-2 text-3xl font-semibold text-emerald-300">{data?.summary.tlsEnabled ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Auth protected</p>
          <p className="mt-2 text-3xl font-semibold text-cyan-200">{data?.summary.authProtected ?? 0}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-4 dark:border-white/10">
          {accessTierTabs().map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setAccessTierFilter(tab.value as "all" | AccessTier)}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                accessTierFilter === tab.value
                  ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                  : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
              )}
            >
              {tab.value === "all" ? <Globe className="h-4 w-4" /> : <AccessTierBadge tier={tab.value} compact className="h-6 min-w-6 px-1.5" />}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search hostnames, services, namespaces, or middleware…"
              className="w-full rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
            />
          </div>
          <select
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
          </select>
          <select
            value={authFilter}
            onChange={(event) => setAuthFilter(event.target.value as typeof authFilter)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">Any auth</option>
            <option value="auth">Auth middleware</option>
            <option value="public">No auth middleware</option>
          </select>
          <select
            value={tlsFilter}
            onChange={(event) => setTlsFilter(event.target.value as typeof tlsFilter)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">Any TLS</option>
            <option value="tls">TLS enabled</option>
            <option value="plain">No TLS</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-56 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 py-16 text-center text-sm text-slate-500">
          No IngressRoutes matched the current filters.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((route) => (
            <div key={route.id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{route.name}</h2>
                    <AccessTierBadge tier={route.accessTier} />
                    {route.hasTls ? <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200">TLS</span> : <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-1 text-xs text-yellow-200">Plain HTTP</span>}
                    {route.authMiddlewares.length > 0 ? <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">Auth</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{route.namespace} · entrypoints {route.entryPoints.join(", ") || "default"}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {route.hosts.length > 0 ? route.hosts.map((host) => (
                  <span key={host} className={cn(
                    "rounded-full border px-2.5 py-1 text-xs",
                    host.includes(".int.") ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-200" : "border-cyan-500/30 bg-cyan-500/10 text-cyan-200"
                  )}>{host}</span>
                )) : <span className="text-sm text-slate-500">No Host() matcher found.</span>}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Backends</p>
                  <div className="mt-2 space-y-1 text-sm text-gray-900 dark:text-white">
                    {route.services.length > 0 ? route.services.map((service) => <p key={service}>{service}</p>) : <p className="text-slate-500">No services listed.</p>}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">TLS</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{route.tlsSecretName ?? route.certResolver ?? "No TLS details"}</p>
                  <p className="mt-1 text-xs text-slate-500">{route.tlsSecretName ? "Secret" : route.certResolver ? "certResolver" : ""}</p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Auth middlewares</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {route.authMiddlewares.length > 0 ? route.authMiddlewares.map((middleware) => (
                      <span key={middleware} className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">{middleware}</span>
                    )) : <span className="text-sm text-slate-500">No auth middleware</span>}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">All middlewares</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {route.middlewares.length > 0 ? route.middlewares.map((middleware) => (
                      <span key={middleware} className="rounded-full border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300">{middleware}</span>
                    )) : <span className="text-sm text-slate-500">No middlewares attached</span>}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
