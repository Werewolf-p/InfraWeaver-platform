"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe, Info, Network, Plus, RefreshCw, Server, ShieldCheck, Trash2 } from "lucide-react";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { RouteEditorSheet } from "@/components/routing/route-editor-sheet";
import { ActionsMenu } from "@/components/ui/actions-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { type AccessTier } from "@/lib/access-tier";
import type { ExternalRouteItem, ExternalRoutesResponse } from "@/lib/external-routes";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { useRBAC } from "@/hooks/use-rbac";

interface LiveIngressRoute {
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
  ingressRoutes: LiveIngressRoute[];
  live: boolean;
  summary: { total: number; authProtected: number; tlsEnabled: number; hosts: number };
}

interface PortRoutingServer {
  name: string;
  targetIP: string;
  ports: Array<{ port: number; protocol: string; name: string }>;
}

interface PortRoutingResponse {
  servers: PortRoutingServer[];
  conflicts: Array<{ ip: string; port: number; protocol: string; servers: string[] }>;
}

type RouteSource = "managed" | "live";

interface UnifiedRoute {
  key: string;
  name: string;
  hosts: string[];
  accessTier: AccessTier;
  targetSummary: string;
  enableAuth: boolean;
  hasTls: boolean;
  source: RouteSource;
  alsoLive: boolean;
  detail: string;
  managed: ExternalRouteItem | null;
}

type TabKey = "all" | "managed" | "live" | "ports";

const TABS: Array<{ key: TabKey; label: string; icon: typeof Globe }> = [
  { key: "all", label: "All routes", icon: Globe },
  { key: "managed", label: "Managed (editable)", icon: Server },
  { key: "live", label: "Live ingress", icon: ShieldCheck },
  { key: "ports", label: "Port routing", icon: Network },
];

function managedTargetSummary(route: ExternalRouteItem) {
  if (route.targetType === "baremetal") {
    return route.targetIP ? `${route.targetIP}:${route.targetPort}` : `bare-metal:${route.targetPort}`;
  }
  return `${route.targetNamespace}/${route.targetService}:${route.targetPort}`;
}

function buildUnifiedRoutes(managed: ExternalRouteItem[], live: LiveIngressRoute[]): UnifiedRoute[] {
  const managedHosts = new Set<string>();
  const managedNames = new Set<string>();
  for (const route of managed) {
    managedNames.add(route.name);
    for (const host of route.hosts) managedHosts.add(host);
  }

  const managedRows: UnifiedRoute[] = managed.map((route) => {
    const matchedLive = live.some(
      (item) => item.name === route.name || item.hosts.some((host) => route.hosts.includes(host)),
    );
    return {
      key: `managed:${route.id}`,
      name: route.name,
      hosts: route.hosts,
      accessTier: route.accessTier,
      targetSummary: managedTargetSummary(route),
      enableAuth: route.enableAuth,
      hasTls: route.hasTls,
      source: "managed",
      alsoLive: matchedLive,
      detail: route.file,
      managed: route,
    };
  });

  const liveOnlyRows: UnifiedRoute[] = live
    .filter((item) => !managedNames.has(item.name) && !item.hosts.some((host) => managedHosts.has(host)))
    .map((item) => ({
      key: `live:${item.id}`,
      name: item.name,
      hosts: item.hosts,
      accessTier: item.accessTier,
      targetSummary: item.services[0] ?? "—",
      enableAuth: item.authMiddlewares.length > 0,
      hasTls: item.hasTls,
      source: "live",
      alsoLive: true,
      detail: `${item.namespace} · cluster-discovered`,
      managed: null,
    }));

  return [...managedRows, ...liveOnlyRows].sort((a, b) => a.name.localeCompare(b.name));
}

export default function RoutingPage() {
  const { can } = useRBAC();
  const canWrite = can("infra:write");

  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [accessTierFilter, setAccessTierFilter] = useState<"all" | AccessTier>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ExternalRouteItem | null>(null);
  const [routeToDelete, setRouteToDelete] = useState<ExternalRouteItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const managedQuery = useQuery<ExternalRoutesResponse>({
    queryKey: ["external-routes"],
    queryFn: async () => {
      const response = await fetch("/api/routes/external", { cache: "no-store" });
      const payload = (await response.json()) as ExternalRoutesResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to load external routes");
      return payload;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const liveQuery = useQuery<IngressResponse>({
    queryKey: ["ingress-routes"],
    queryFn: async () => {
      const response = await fetch("/api/ingress", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch ingress routes");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const portsQuery = useQuery<PortRoutingResponse>({
    queryKey: ["port-routing"],
    queryFn: async () => {
      const response = await fetch("/api/gameservers/ports", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch port routing");
      return response.json();
    },
    enabled: tab === "ports",
    staleTime: 30_000,
  });

  const managedRoutes = useMemo(() => (Array.isArray(managedQuery.data?.routes) ? managedQuery.data.routes : []), [managedQuery.data]);
  const liveRoutes = useMemo(() => liveQuery.data?.ingressRoutes ?? [], [liveQuery.data]);
  const unified = useMemo(() => buildUnifiedRoutes(managedRoutes, liveRoutes), [managedRoutes, liveRoutes]);

  const tableRoutes = useMemo(() => {
    const bySource = unified.filter((route) => {
      if (tab === "managed") return route.source === "managed";
      return true;
    });
    const liveScoped = tab === "live" ? bySource.filter((route) => route.alsoLive) : bySource;
    const query = search.trim().toLowerCase();
    return liveScoped.filter((route) => {
      if (accessTierFilter !== "all" && route.accessTier !== accessTierFilter) return false;
      if (!query) return true;
      return [route.name, route.hosts.join(" "), route.targetSummary, route.detail].join(" ").toLowerCase().includes(query);
    });
  }, [unified, tab, search, accessTierFilter]);

  function openCreate() {
    setEditingRoute(null);
    setEditorOpen(true);
  }

  function openEdit(route: ExternalRouteItem) {
    setEditingRoute(route);
    setEditorOpen(true);
  }

  async function refreshAll() {
    await Promise.all([managedQuery.refetch(), liveQuery.refetch(), tab === "ports" ? portsQuery.refetch() : Promise.resolve()]);
  }

  async function deleteRoute() {
    if (!routeToDelete) return;
    if (!canWrite) {
      toast.error("You do not have permission to delete routes");
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`/api/routes/external/${encodeURIComponent(routeToDelete.name)}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to delete route");
      toast.success(`Deleted ${routeToDelete.name}`);
      setRouteToDelete(null);
      await managedQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete route");
    } finally {
      setDeleting(false);
    }
  }

  const isFetching = managedQuery.isFetching || liveQuery.isFetching;
  const managedError = managedQuery.error;
  const counts = {
    all: unified.length,
    managed: unified.filter((route) => route.source === "managed").length,
    live: unified.filter((route) => route.alsoLive).length,
    ports: portsQuery.data?.servers.length ?? 0,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Routing"
        subtitle="One place for ingress routes, managed external routes, and port routing."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshAll()}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white"
            >
              <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
              Refresh
            </button>
            <button
              type="button"
              onClick={openCreate}
              disabled={!canWrite}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-700 dark:text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add route
            </button>
          </div>
        }
      />

      <div className="flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 p-4 text-sm text-sky-100">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <p className="font-medium">Managed routes are committed to git and applied by ArgoCD (~30-60s).</p>
          <p className="mt-1 text-sky-100/80">
            Live ingress rows are read-only — they reflect what Traefik is actually serving in the cluster. Port routing covers
            DNS-based TCP/UDP port forwards.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
              tab === key
                ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
            )}
          >
            <Icon className="h-4 w-4" />
            <span>{label}</span>
            <span className="rounded-full bg-slate-200/70 px-2 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-300">
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      {tab === "ports" ? (
        <PortRoutingPanel query={portsQuery} />
      ) : (
        <DashboardPanel title="Routes" description="Search and filter across managed and live routes." icon={Server}>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {(["all", "vpn", "internal", "public"] as const).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setAccessTierFilter(tier)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                    accessTierFilter === tier
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-200"
                      : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
                  )}
                >
                  {tier === "all" ? <Globe className="h-4 w-4" /> : <AccessTierBadge tier={tier} compact className="h-6 min-w-6 px-1.5" />}
                  <span className="capitalize">{tier}</span>
                </button>
              ))}
            </div>

            <ToolbarSearchInput value={search} onChange={setSearch} placeholder="Search hostnames, backends, namespaces…" />

            {managedError && tab !== "live" ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
                {managedError instanceof Error ? managedError.message : "Managed routes could not be loaded."}
              </div>
            ) : null}
            {liveQuery.data?.live === false && tab !== "managed" ? (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
                Kubernetes unavailable — live ingress data cannot be loaded.
              </div>
            ) : null}

            {managedQuery.isLoading || liveQuery.isLoading ? (
              <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-6 text-sm text-slate-500">
                Loading routes…
              </div>
            ) : tableRoutes.length === 0 ? (
              <EmptyState
                icon={Globe}
                title="No routes matched"
                description="Adjust the tab, access-tier filter, or search query."
                action={{ label: "Reset filters", onClick: () => { setSearch(""); setAccessTierFilter("all"); } }}
                className="py-12"
              />
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-[#2a2a2a] bg-slate-50/80 dark:bg-[#0f0f0f] text-left text-xs text-slate-500 dark:text-[#888]">
                      <th className="px-4 py-3 font-medium">Name</th>
                      <th className="px-4 py-3 font-medium">Hosts</th>
                      <th className="px-4 py-3 font-medium">Tier</th>
                      <th className="px-4 py-3 font-medium">Target</th>
                      <th className="px-4 py-3 font-medium">Source</th>
                      <th className="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRoutes.map((route) => (
                      <tr
                        key={route.key}
                        onClick={() => route.managed && openEdit(route.managed)}
                        className={cn(
                          "border-b border-gray-200 transition dark:border-[#1e1e1e]",
                          route.managed
                            ? "cursor-pointer hover:bg-slate-50/80 dark:hover:bg-[#141414]"
                            : "opacity-90",
                        )}
                      >
                        <td className="px-4 py-3 align-top">
                          <div className="font-medium text-gray-900 dark:text-white">{route.name}</div>
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{route.detail}</p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-wrap gap-2">
                            {route.hosts.length > 0 ? (
                              route.hosts.map((host) => (
                                <span key={host} className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                                  {host}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-slate-500">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <AccessTierBadge tier={route.accessTier} />
                        </td>
                        <td className="px-4 py-3 align-top text-slate-700 dark:text-slate-300">
                          <div className="text-xs text-slate-500 dark:text-slate-400">{route.targetSummary}</div>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {route.enableAuth ? (
                              <span className="inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-300">auth</span>
                            ) : null}
                            <span className={cn(
                              "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                              route.hasTls ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-yellow-500/30 bg-yellow-500/10 text-yellow-200",
                            )}>
                              {route.hasTls ? "TLS" : "plain"}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {route.source === "managed" ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-300">
                              Managed{route.alsoLive ? " · live" : ""}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-slate-100 px-2.5 py-1 text-xs text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
                              Live only
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top text-right" onClick={(event) => event.stopPropagation()}>
                          {route.managed ? (
                            <ActionsMenu
                              actions={[
                                { label: "Edit route", onClick: () => openEdit(route.managed!) },
                                { label: "Delete route", icon: <Trash2 className="h-4 w-4" />, variant: "destructive", onClick: () => setRouteToDelete(route.managed), disabled: !canWrite },
                              ]}
                            />
                          ) : (
                            <span className="text-xs text-slate-400">read-only</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DashboardPanel>
      )}

      <RouteEditorSheet
        open={editorOpen}
        editingRoute={editingRoute}
        canWrite={canWrite}
        onClose={() => setEditorOpen(false)}
        onSaved={refreshAll}
      />

      <ConfirmDialog
        open={Boolean(routeToDelete)}
        onCancel={() => !deleting && setRouteToDelete(null)}
        onConfirm={() => void deleteRoute()}
        title={routeToDelete ? `Delete ${routeToDelete.name}?` : "Delete route?"}
        description="This removes the route manifest and any dedicated backend objects managed for it."
        confirmText={deleting ? "Deleting…" : "Delete route"}
        danger
      />
    </div>
  );
}

function PortRoutingPanel({ query }: { query: ReturnType<typeof useQuery<PortRoutingResponse>> }) {
  const servers = query.data?.servers ?? [];
  const conflicts = query.data?.conflicts ?? [];

  return (
    <DashboardPanel
      title="Port routing"
      description="DNS-based TCP/UDP port forwards for external services (game servers and similar)."
      icon={Network}
    >
      <div className="space-y-4">
        <div className="flex justify-end">
          <Link href="/gameservers" className="inline-flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-500 dark:text-sky-300">
            Manage port routing <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>

        {conflicts.length > 0 ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
            <p className="font-medium">{conflicts.length} port conflict{conflicts.length > 1 ? "s" : ""} detected</p>
            <ul className="mt-2 space-y-1 text-red-200/90">
              {conflicts.map((conflict) => (
                <li key={`${conflict.ip}:${conflict.port}:${conflict.protocol}`}>
                  {conflict.ip}:{conflict.port}/{conflict.protocol} — {conflict.servers.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {query.isLoading ? (
          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-6 text-sm text-slate-500">
            Loading port routing…
          </div>
        ) : query.error ? (
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
            Port routing data is unavailable (Kubernetes or game-hub may be offline).
          </div>
        ) : servers.length === 0 ? (
          <EmptyState icon={Network} title="No port routes" description="No DNS-based port forwards are configured yet." className="py-12" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-[#2a2a2a] bg-slate-50/80 dark:bg-[#0f0f0f] text-left text-xs text-slate-500 dark:text-[#888]">
                  <th className="px-4 py-3 font-medium">Service</th>
                  <th className="px-4 py-3 font-medium">Target IP</th>
                  <th className="px-4 py-3 font-medium">Ports</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((server) => (
                  <tr key={server.name} className="border-b border-gray-200 dark:border-[#1e1e1e]">
                    <td className="px-4 py-3 align-top font-medium text-gray-900 dark:text-white">{server.name}</td>
                    <td className="px-4 py-3 align-top text-slate-600 dark:text-slate-300">{server.targetIP || "—"}</td>
                    <td className="px-4 py-3 align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {server.ports.length > 0 ? (
                          server.ports.map((port) => (
                            <span key={`${port.port}/${port.protocol}`} className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                              {port.port}/{port.protocol}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardPanel>
  );
}
