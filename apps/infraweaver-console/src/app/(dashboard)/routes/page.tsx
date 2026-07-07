"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Cloud,
  ExternalLink,
  Globe,
  Info,
  Layers,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { RouteEditorSheet } from "@/components/routing/route-editor-sheet";
import { DnsRecordDialog, type DnsRecordDefaults } from "@/components/dns/dns-record-dialog";
import { ActionsMenu } from "@/components/ui/actions-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { ACCESS_TIER_MIDDLEWARES, type AccessTier } from "@/lib/access-tier";
import { INTERNAL_DNS_DOMAIN, isInternalDnsName, type ManagedDnsRecord } from "@/lib/dns";
import type { ExternalRouteItem, ExternalRoutesResponse } from "@/lib/external-routes";
import { cn, timeAgo } from "@/lib/utils";
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

interface DnsResponse {
  records: ManagedDnsRecord[];
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
  middlewares: string[];
  enableAuth: boolean;
  hasTls: boolean;
  source: RouteSource;
  alsoLive: boolean;
  detail: string;
  managed: ExternalRouteItem | null;
}

type TabKey = "all" | "manual" | "auto" | "dns" | "middleware" | "ports";

const TABS: Array<{ key: TabKey; label: string; icon: typeof Globe; hint: string }> = [
  { key: "all", label: "All", icon: Layers, hint: "Every route + DNS in one place" },
  { key: "manual", label: "Manual", icon: Server, hint: "Routes you created (editable, git-managed)" },
  { key: "auto", label: "Auto-generated", icon: Sparkles, hint: "Routes Traefik discovered in-cluster" },
  { key: "dns", label: "DNS", icon: Globe, hint: "Cloudflare + internal DNS records" },
  { key: "middleware", label: "Middleware", icon: Wrench, hint: "Traefik middlewares used by routes" },
  { key: "ports", label: "Port routing", icon: Network, hint: "TCP/UDP port forwards" },
];

function managedTargetSummary(route: ExternalRouteItem) {
  if (route.targetType === "baremetal") {
    return route.targetIP ? `${route.targetIP}:${route.targetPort}` : `bare-metal:${route.targetPort}`;
  }
  return `${route.targetNamespace}/${route.targetService}:${route.targetPort}`;
}

function shortMiddleware(value: string) {
  return value.split("/").pop()?.trim() ?? value;
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
      middlewares: route.middlewares ?? [],
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
      middlewares: [...item.middlewares, ...item.authMiddlewares],
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
  const canWriteDns = can("config:write");

  const [tab, setTab] = useState<TabKey>("all");
  const [search, setSearch] = useState("");
  const [accessTierFilter, setAccessTierFilter] = useState<"all" | AccessTier>("all");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ExternalRouteItem | null>(null);
  const [routeToDelete, setRouteToDelete] = useState<ExternalRouteItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [dnsDialogOpen, setDnsDialogOpen] = useState(false);
  const [dnsDefaults, setDnsDefaults] = useState<DnsRecordDefaults>({});
  const [editingDns, setEditingDns] = useState<ManagedDnsRecord | null>(null);
  const [dnsToDelete, setDnsToDelete] = useState<ManagedDnsRecord | null>(null);

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

  const dnsQuery = useQuery<DnsResponse>({
    queryKey: ["dns", "records"],
    queryFn: async () => {
      const response = await fetch("/api/dns", { cache: "no-store" });
      const payload = (await response.json()) as DnsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to load DNS records");
      return payload;
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
  const dnsRecords = useMemo(() => dnsQuery.data?.records ?? [], [dnsQuery.data]);
  const unified = useMemo(() => buildUnifiedRoutes(managedRoutes, liveRoutes), [managedRoutes, liveRoutes]);

  // Map hostname -> DNS record so each route row can show whether DNS is wired.
  const dnsByHost = useMemo(() => {
    const map = new Map<string, ManagedDnsRecord>();
    for (const record of dnsRecords) map.set(record.name.toLowerCase().replace(/\.+$/, ""), record);
    return map;
  }, [dnsRecords]);

  function dnsForHost(host: string): ManagedDnsRecord | null {
    return dnsByHost.get(host.toLowerCase().replace(/\.+$/, "")) ?? null;
  }

  const tableRoutes = useMemo(() => {
    const bySource = unified.filter((route) => {
      if (tab === "manual") return route.source === "managed";
      if (tab === "auto") return route.source === "live";
      return true;
    });
    const query = search.trim().toLowerCase();
    return bySource.filter((route) => {
      if (accessTierFilter !== "all" && route.accessTier !== accessTierFilter) return false;
      if (!query) return true;
      return [route.name, route.hosts.join(" "), route.targetSummary, route.detail, route.middlewares.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(query);
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

  function openDnsForHost(host: string) {
    const existing = dnsForHost(host);
    if (existing) {
      setEditingDns(existing);
      setDnsDefaults({});
    } else {
      setEditingDns(null);
      setDnsDefaults({ name: host, type: "A", internal: isInternalDnsName(host) });
    }
    setDnsDialogOpen(true);
  }

  function openDnsCreate() {
    setEditingDns(null);
    setDnsDefaults({ type: "A", internal: false });
    setDnsDialogOpen(true);
  }

  async function refreshAll() {
    await Promise.all([
      managedQuery.refetch(),
      liveQuery.refetch(),
      dnsQuery.refetch(),
      tab === "ports" ? portsQuery.refetch() : Promise.resolve(),
    ]);
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

  async function deleteDnsRecord() {
    if (!dnsToDelete) return;
    if (!canWriteDns) {
      toast.error("You do not have permission to delete DNS records");
      return;
    }
    try {
      const response = await fetch(`/api/dns/${dnsToDelete.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to delete DNS record");
      toast.success(`Deleted ${dnsToDelete.name}`);
      setDnsToDelete(null);
      await dnsQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete DNS record");
    }
  }

  const isFetching = managedQuery.isFetching || liveQuery.isFetching || dnsQuery.isFetching;
  const managedError = managedQuery.error;
  const counts: Record<TabKey, number> = {
    all: unified.length,
    manual: unified.filter((route) => route.source === "managed").length,
    auto: unified.filter((route) => route.source === "live").length,
    dns: dnsRecords.length,
    middleware: new Set(unified.flatMap((route) => route.middlewares.map(shortMiddleware))).size,
    ports: portsQuery.data?.servers.length ?? 0,
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="Routing & DNS"
        subtitle="One place for routes, DNS records, access modes, and middleware."
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
            {tab === "dns" ? (
              <button
                type="button"
                onClick={openDnsCreate}
                disabled={!canWriteDns}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-700 dark:text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add DNS record
              </button>
            ) : (
              <button
                type="button"
                onClick={openCreate}
                disabled={!canWrite}
                className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-700 dark:text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Add route
              </button>
            )}
          </div>
        }
      />

      <div className="flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 p-4 text-sm text-sky-700 dark:text-sky-100">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <p className="font-medium">Manual routes & DNS records are committed to git / Cloudflare and applied automatically (~30-60s).</p>
          <p className="mt-1 text-sky-700/80 dark:text-sky-100/80">
            Auto-generated rows are read-only — they mirror what Traefik is actually serving. Use a row&rsquo;s menu to edit its access
            mode &amp; middleware, manage its DNS record, or remove it.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ key, label, icon: Icon, hint }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            title={hint}
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
      ) : tab === "middleware" ? (
        <MiddlewarePanel routes={unified} loading={managedQuery.isLoading || liveQuery.isLoading} />
      ) : tab === "dns" ? (
        <DnsPanel
          records={dnsRecords}
          loading={dnsQuery.isLoading}
          error={dnsQuery.error}
          canWrite={canWriteDns}
          onAdd={openDnsCreate}
          onEdit={(record) => {
            setEditingDns(record);
            setDnsDefaults({});
            setDnsDialogOpen(true);
          }}
          onDelete={setDnsToDelete}
          onRefetch={() => void dnsQuery.refetch()}
        />
      ) : (
        <DashboardPanel title="Routes" description="Search and filter across manual and auto-generated routes." icon={Server}>
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
                  <span className="capitalize">{tier === "all" ? "All modes" : tier}</span>
                </button>
              ))}
            </div>

            <ToolbarSearchInput value={search} onChange={setSearch} placeholder="Search hostnames, backends, middleware…" />

            {managedError && tab !== "auto" ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-200">
                {managedError instanceof Error ? managedError.message : "Manual routes could not be loaded."}
              </div>
            ) : null}
            {liveQuery.data?.live === false && tab !== "manual" ? (
              <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-600 dark:text-amber-200">
                Kubernetes unavailable — auto-generated routes cannot be loaded.
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
                description="Adjust the tab, mode filter, or search query."
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
                      <th className="px-4 py-3 font-medium">Mode</th>
                      <th className="px-4 py-3 font-medium">Target</th>
                      <th className="px-4 py-3 font-medium">DNS</th>
                      <th className="px-4 py-3 font-medium">Middleware</th>
                      <th className="px-4 py-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRoutes.map((route) => {
                      const primaryHost = route.hosts[0];
                      const dnsRecord = primaryHost ? dnsForHost(primaryHost) : null;
                      return (
                        <tr
                          key={route.key}
                          onClick={() => route.managed && openEdit(route.managed)}
                          className={cn(
                            "border-b border-gray-200 transition dark:border-[#1e1e1e]",
                            route.managed
                              ? "cursor-pointer hover:bg-slate-50/80 dark:hover:bg-[#141414]"
                              : "opacity-95",
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
                                <span className="inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-700 dark:text-cyan-300">auth</span>
                              ) : null}
                              <span className={cn(
                                "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                                route.hasTls ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-200",
                              )}>
                                {route.hasTls ? "TLS" : "plain"}
                              </span>
                              <span className={cn(
                                "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                                route.source === "managed"
                                  ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                  : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
                              )}>
                                {route.source === "managed" ? `manual${route.alsoLive ? " · live" : ""}` : "auto"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            {dnsRecord ? (
                              <span className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]",
                                dnsRecord.proxied
                                  ? "border-[#f38020]/40 bg-[#f38020]/10 text-[#c25b15] dark:text-[#ff9a3d]"
                                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                              )}>
                                <Cloud className={cn("h-3 w-3", dnsRecord.proxied && "fill-current")} />
                                {dnsRecord.type} {dnsRecord.proxied ? "proxied" : "DNS-only"}
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full border border-slate-300 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-400">
                                no record
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-wrap gap-1.5">
                              {route.middlewares.length > 0 ? (
                                route.middlewares.slice(0, 3).map((middleware) => (
                                  <span key={middleware} className="inline-flex rounded-full border border-gray-200 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                                    {shortMiddleware(middleware)}
                                  </span>
                                ))
                              ) : (
                                <span className="text-xs text-slate-400">—</span>
                              )}
                              {route.middlewares.length > 3 ? (
                                <span className="text-[11px] text-slate-400">+{route.middlewares.length - 3}</span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top text-right" onClick={(event) => event.stopPropagation()}>
                            <ActionsMenu
                              actions={[
                                ...(route.managed
                                  ? [{ label: "Edit route (mode, auth, middleware)", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(route.managed!), disabled: !canWrite }]
                                  : []),
                                {
                                  label: primaryHost ? (dnsRecord ? "Edit DNS record" : "Add DNS record") : "No host for DNS",
                                  icon: <Globe className="h-4 w-4" />,
                                  onClick: () => primaryHost && openDnsForHost(primaryHost),
                                  disabled: !canWriteDns || !primaryHost,
                                },
                                ...(route.managed
                                  ? [{ label: "Delete route", icon: <Trash2 className="h-4 w-4" />, variant: "destructive" as const, onClick: () => setRouteToDelete(route.managed), disabled: !canWrite }]
                                  : []),
                              ]}
                            />
                          </td>
                        </tr>
                      );
                    })}
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

      {dnsDialogOpen ? (
        <DnsRecordDialog
          open={dnsDialogOpen}
          onOpenChange={setDnsDialogOpen}
          record={editingDns}
          defaultValues={dnsDefaults}
          canWrite={canWriteDns}
          onSubmitted={async () => {
            await dnsQuery.refetch();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(routeToDelete)}
        onCancel={() => !deleting && setRouteToDelete(null)}
        onConfirm={() => void deleteRoute()}
        title={routeToDelete ? `Delete ${routeToDelete.name}?` : "Delete route?"}
        description="This removes the route manifest and any dedicated backend objects managed for it."
        confirmText={deleting ? "Deleting…" : "Delete route"}
        danger
      />

      <ConfirmDialog
        open={Boolean(dnsToDelete)}
        onCancel={() => setDnsToDelete(null)}
        onConfirm={() => void deleteDnsRecord()}
        title={dnsToDelete ? `Delete ${dnsToDelete.name}?` : "Delete DNS record?"}
        description={dnsToDelete ? `This permanently removes the ${dnsToDelete.type} record pointing to ${dnsToDelete.value}.` : undefined}
        confirmText="Delete record"
        danger
      />
    </div>
  );
}

type DnsScope = "all" | "internal" | "public";

function DnsPanel({
  records,
  loading,
  error,
  canWrite,
  onAdd,
  onEdit,
  onDelete,
  onRefetch,
}: {
  records: ManagedDnsRecord[];
  loading: boolean;
  error: unknown;
  canWrite: boolean;
  onAdd: () => void;
  onEdit: (record: ManagedDnsRecord) => void;
  onDelete: (record: ManagedDnsRecord) => void;
  onRefetch: () => void;
}) {
  const [scope, setScope] = useState<DnsScope>("all");
  const [search, setSearch] = useState("");
  const [proxyUpdatingIds, setProxyUpdatingIds] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const scoped = records.filter((record) => (scope === "all" ? true : scope === "internal" ? record.internal : !record.internal));
    const query = search.trim().toLowerCase();
    if (!query) return scoped;
    return scoped.filter((record) => [record.name, record.shortName, record.value, record.type].some((value) => value.toLowerCase().includes(query)));
  }, [records, scope, search]);

  const counts = {
    all: records.length,
    internal: records.filter((record) => record.internal).length,
    public: records.filter((record) => !record.internal).length,
  };

  async function toggleProxy(record: ManagedDnsRecord) {
    if (!canWrite) {
      toast.error("You do not have permission to update DNS records");
      return;
    }
    if (record.type !== "A" && record.type !== "CNAME") return;
    setProxyUpdatingIds((current) => [...current, record.id]);
    try {
      const res = await fetch(`/api/dns/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxied: !record.proxied }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to update proxy status");
      toast.success(`${record.name} is now ${record.proxied ? "DNS-only" : "proxied"}`);
      onRefetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update proxy status");
    } finally {
      setProxyUpdatingIds((current) => current.filter((id) => id !== record.id));
    }
  }

  return (
    <DashboardPanel
      title="DNS records"
      description={`Internal targets *.${INTERNAL_DNS_DOMAIN}; public records resolve through Cloudflare.`}
      icon={Globe}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "internal", "public"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                scope === value
                  ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200"
                  : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
              )}
            >
              {value === "internal" ? <ShieldCheck className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
              <span className="capitalize">{value === "all" ? "All records" : value}</span>
              <span className="rounded-full bg-slate-200/70 px-2 text-xs text-slate-600 dark:bg-white/10 dark:text-slate-300">{counts[value]}</span>
            </button>
          ))}
        </div>

        <ToolbarSearchInput value={search} onChange={setSearch} placeholder="Search DNS names, values, types…" />

        {error ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-200">
            {error instanceof Error ? error.message : "DNS records could not be loaded."}
          </div>
        ) : null}

        {loading ? (
          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-6 text-sm text-slate-500">
            Loading DNS records…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No DNS records"
            description={error ? "DNS provider is unavailable — check Cloudflare configuration." : "No records match this scope or search."}
            action={canWrite && !error ? { label: "Add DNS record", onClick: onAdd } : undefined}
            className="py-12"
          />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-[#2a2a2a] bg-slate-50/80 dark:bg-[#0f0f0f] text-left text-xs text-slate-500 dark:text-[#888]">
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Scope</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">TTL</th>
                  <th className="px-4 py-3 font-medium">Updated</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((record) => {
                  const supportsProxy = record.type === "A" || record.type === "CNAME";
                  const isUpdating = proxyUpdatingIds.includes(record.id);
                  return (
                    <tr key={record.id} className="border-b border-gray-200 dark:border-[#1e1e1e] hover:bg-slate-50/80 dark:hover:bg-[#141414]">
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-900 dark:text-white">{record.name}</span>
                          <CopyButton text={record.name} className="px-1.5 py-0.5" />
                        </div>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{record.shortName}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className={cn(
                          "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                          record.internal
                            ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        )}>
                          {record.internal ? "Internal" : "Public"}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className="inline-flex rounded-full border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-300">{record.type}</span>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex items-center gap-2">
                          <span className="max-w-[260px] truncate font-mono text-xs text-slate-800 dark:text-slate-200" title={record.value}>{record.value}</span>
                          <CopyButton text={record.value} className="px-1.5 py-0.5" />
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-slate-600 dark:text-slate-300">{record.ttl}s</td>
                      <td className="px-4 py-3 align-top text-slate-500 dark:text-slate-400">{record.updatedAt ? timeAgo(record.updatedAt) : "—"}</td>
                      <td className="px-4 py-3 align-top text-right">
                        <div className="flex justify-end gap-2">
                          {supportsProxy ? (
                            <button
                              type="button"
                              onClick={() => void toggleProxy(record)}
                              disabled={!canWrite || isUpdating}
                              title={record.proxied ? "Disable Cloudflare proxy" : "Enable Cloudflare proxy"}
                              className={cn(
                                "rounded-lg border p-2 transition disabled:cursor-not-allowed disabled:opacity-50",
                                record.proxied
                                  ? "border-[#f38020]/40 bg-[#f38020]/10 text-[#f38020] hover:bg-[#f38020]/20 dark:text-[#ff9a3d]"
                                  : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white",
                                isUpdating && "animate-pulse",
                              )}
                            >
                              <Cloud className={cn("h-4 w-4", record.proxied && "fill-current")} />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => canWrite && onEdit(record)}
                            disabled={!canWrite}
                            className="rounded-lg border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 p-2 text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                            title={`Edit ${record.name}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => canWrite && onDelete(record)}
                            disabled={!canWrite}
                            className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-red-600 dark:text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                            title={`Delete ${record.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardPanel>
  );
}

interface MiddlewareUsage {
  name: string;
  isAuth: boolean;
  routes: Array<{ name: string; hosts: string[]; tier: AccessTier }>;
}

function MiddlewarePanel({ routes, loading }: { routes: UnifiedRoute[]; loading: boolean }) {
  const tierMiddlewares = new Set(Object.values(ACCESS_TIER_MIDDLEWARES).map((value) => value.toLowerCase()));

  const usage = useMemo(() => {
    const map = new Map<string, MiddlewareUsage>();
    for (const route of routes) {
      for (const middleware of route.middlewares) {
        const short = shortMiddleware(middleware);
        const existing = map.get(short) ?? { name: short, isAuth: tierMiddlewares.has(short.toLowerCase()) || /auth|oidc|forward/i.test(short), routes: [] };
        existing.routes.push({ name: route.name, hosts: route.hosts, tier: route.accessTier });
        map.set(short, existing);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.routes.length - a.routes.length || a.name.localeCompare(b.name));
  }, [routes]);

  return (
    <DashboardPanel
      title="Middleware"
      description="Traefik middlewares referenced by routes, and where they are applied."
      icon={Wrench}
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/10 p-4 text-sm text-violet-700 dark:text-violet-200">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <p>
            Access mode (VPN / Internal / Public) maps to forward-auth middleware automatically. Edit a route from any routes tab to
            change which middlewares it uses.
          </p>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-6 text-sm text-slate-500">
            Loading middleware usage…
          </div>
        ) : usage.length === 0 ? (
          <EmptyState icon={Wrench} title="No middleware in use" description="No routes currently reference Traefik middlewares." className="py-12" />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-gray-200 dark:border-white/10">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-[#2a2a2a] bg-slate-50/80 dark:bg-[#0f0f0f] text-left text-xs text-slate-500 dark:text-[#888]">
                  <th className="px-4 py-3 font-medium">Middleware</th>
                  <th className="px-4 py-3 font-medium">Kind</th>
                  <th className="px-4 py-3 font-medium">Used by</th>
                  <th className="px-4 py-3 font-medium">Routes</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((middleware) => (
                  <Fragment key={middleware.name}>
                    <tr className="border-b border-gray-200 dark:border-[#1e1e1e]">
                      <td className="px-4 py-3 align-top font-medium text-gray-900 dark:text-white">{middleware.name}</td>
                      <td className="px-4 py-3 align-top">
                        <span className={cn(
                          "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                          middleware.isAuth
                            ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                            : "border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300",
                        )}>
                          {middleware.isAuth ? "auth / access" : "general"}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top text-slate-600 dark:text-slate-300">{middleware.routes.length} route{middleware.routes.length === 1 ? "" : "s"}</td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap gap-1.5">
                          {middleware.routes.slice(0, 6).map((route) => (
                            <span key={route.name} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300" title={route.hosts.join(", ")}>
                              {route.name}
                            </span>
                          ))}
                          {middleware.routes.length > 6 ? <span className="text-[11px] text-slate-400">+{middleware.routes.length - 6}</span> : null}
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </DashboardPanel>
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
          <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-200">
            <p className="font-medium">{conflicts.length} port conflict{conflicts.length > 1 ? "s" : ""} detected</p>
            <ul className="mt-2 space-y-1 text-red-600/90 dark:text-red-200/90">
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
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-600 dark:text-amber-200">
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
