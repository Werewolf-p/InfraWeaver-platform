"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Globe,
  Info,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { ActionsMenu } from "@/components/ui/actions-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { accessTierTabs, defaultTlsSecretForHost, type AccessTier } from "@/lib/access-tier";
import type { ExternalRouteItem, ExternalRouteTargetType, ExternalRoutesResponse } from "@/lib/external-routes";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { usePlatformApps } from "@/hooks/use-platform-apps";
import { useRBAC } from "@/hooks/use-rbac";

interface RouteFormState {
  name: string;
  host: string;
  accessTier: AccessTier;
  targetType: ExternalRouteTargetType;
  targetService: string;
  targetNamespace: string;
  targetPort: string;
  targetIP: string;
  enableAuth: boolean;
  tlsSecret: string;
  scheme: "http" | "https";
  skipTlsVerify: boolean;
}

const DEFAULT_FORM: RouteFormState = {
  name: "",
  host: "",
  accessTier: "internal",
  targetType: "k8s",
  targetService: "",
  targetNamespace: "default",
  targetPort: "80",
  targetIP: "",
  enableAuth: false,
  tlsSecret: "platform-wildcard-int-tls",
  scheme: "http",
  skipTlsVerify: false,
};

function toFormState(route: ExternalRouteItem): RouteFormState {
  return {
    name: route.name,
    host: route.hosts[0] ?? "",
    accessTier: route.accessTier,
    targetType: route.targetType,
    targetService: route.targetService,
    targetNamespace: route.targetNamespace,
    targetPort: String(route.targetPort),
    targetIP: route.targetIP ?? "",
    enableAuth: route.enableAuth,
    tlsSecret: route.tlsSecretName ?? defaultTlsSecretForHost(route.hosts[0] ?? ""),
    scheme: route.scheme,
    skipTlsVerify: route.skipTlsVerify,
  };
}

function buildTargetSummary(route: ExternalRouteItem) {
  if (route.targetType === "baremetal") {
    return route.targetIP ? `${route.targetIP}:${route.targetPort}` : `Bare-metal:${route.targetPort}`;
  }
  return `${route.targetNamespace}/${route.targetService}:${route.targetPort}`;
}

function accessWarning(route: { accessTier: AccessTier }, netbirdInstalled: boolean) {
  return route.accessTier === "vpn" && !netbirdInstalled
    ? "VPN required — NetBird not installed"
    : null;
}

export default function RoutesPage() {
  const { can } = useRBAC();
  const canWrite = can("infra:write");
  const platformApps = usePlatformApps();
  const netbirdInstalled = platformApps.netbird;

  const [search, setSearch] = useState("");
  const [accessTierFilter, setAccessTierFilter] = useState<"all" | AccessTier>("all");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ExternalRouteItem | null>(null);
  const [form, setForm] = useState<RouteFormState>(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [routeToDelete, setRouteToDelete] = useState<ExternalRouteItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading, isFetching, refetch, error } = useQuery<ExternalRoutesResponse>({
    queryKey: ["external-routes"],
    queryFn: async () => {
      const response = await fetch("/api/routes/external", { cache: "no-store" });
      const payload = await response.json() as ExternalRoutesResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to load external routes");
      return payload;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
  });

  const routes = useMemo(() => data?.routes ?? [], [data?.routes]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return routes.filter((route) => {
      const matchesTier = accessTierFilter === "all" || route.accessTier === accessTierFilter;
      if (!matchesTier) return false;
      if (!query) return true;
      return [
        route.name,
        route.hosts.join(" "),
        route.targetService,
        route.targetNamespace,
        route.targetIP ?? "",
        route.middlewares.join(" "),
      ].join(" ").toLowerCase().includes(query);
    });
  }, [accessTierFilter, routes, search]);

  function updateForm<K extends keyof RouteFormState>(key: K, value: RouteFormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateHost(host: string) {
    setForm((current) => {
      const nextHost = host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      const currentDefault = defaultTlsSecretForHost(current.host);
      const nextDefault = defaultTlsSecretForHost(nextHost);
      return {
        ...current,
        host: nextHost,
        tlsSecret: !current.tlsSecret || current.tlsSecret === currentDefault ? nextDefault : current.tlsSecret,
      };
    });
  }

  function openCreate() {
    setEditingRoute(null);
    setForm(DEFAULT_FORM);
    setEditorOpen(true);
  }

  function openEdit(route: ExternalRouteItem) {
    setEditingRoute(route);
    setForm(toFormState(route));
    setEditorOpen(true);
  }

  async function saveRoute() {
    if (!canWrite) {
      toast.error("You do not have permission to manage routes");
      return;
    }
    if (!form.name.trim() || !form.host.trim()) {
      toast.error("Name and hostname are required");
      return;
    }
    if (!form.targetPort.trim() || Number.isNaN(Number(form.targetPort))) {
      toast.error("Target port must be a valid number");
      return;
    }
    if (form.targetType === "k8s" && (!form.targetService.trim() || !form.targetNamespace.trim())) {
      toast.error("Kubernetes routes need a service name and namespace");
      return;
    }
    if (form.targetType === "baremetal" && !form.targetIP.trim()) {
      toast.error("Bare-metal routes need a target IP");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(editingRoute ? `/api/routes/external/${encodeURIComponent(editingRoute.name)}` : "/api/routes/external", {
        method: editingRoute ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          host: form.host.trim(),
          accessTier: form.accessTier,
          targetType: form.targetType,
          targetService: form.targetService.trim(),
          targetNamespace: form.targetNamespace.trim(),
          targetPort: Number(form.targetPort),
          targetIP: form.targetIP.trim(),
          enableAuth: form.enableAuth,
          tlsSecret: form.tlsSecret.trim() || null,
          scheme: form.scheme,
          skipTlsVerify: form.skipTlsVerify,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to save route");
      toast.success(editingRoute ? `Updated ${editingRoute.name}` : `Created ${form.name}`);
      setEditorOpen(false);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save route");
    } finally {
      setSaving(false);
    }
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
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to delete route");
      toast.success(`Deleted ${routeToDelete.name}`);
      setRouteToDelete(null);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete route");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="External Routes"
        subtitle="Manage Traefik IngressRoutes for public, internal, and VPN-only services."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refetch()}
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
              Add Route
            </button>
          </div>
        }
      />

      <div className="flex items-start gap-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 p-4 text-sm text-sky-100">
        <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <p className="font-medium">Changes are applied via ArgoCD (usually within 30-60s).</p>
          <p className="mt-1 text-sky-100/80">InfraWeaver commits the route manifests to git and pushes them to your configured remote.</p>
        </div>
      </div>

      <DashboardPanel title="Route inventory" description="Search and filter managed routes before editing or removing them." icon={Server}>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
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

          <ToolbarSearchInput value={search} onChange={setSearch} placeholder="Search hostnames, backends, namespaces, or middleware…" />

          {!netbirdInstalled ? (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>NetBird is not installed. VPN-tier routes keep their VPN label but use <span className="font-mono">internal-only</span> middleware until NetBird is enabled.</div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
              {error instanceof Error ? error.message : "External routes could not be loaded."}
            </div>
          ) : isLoading ? (
            <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 p-6 text-sm text-slate-500">Loading external routes…</div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Globe}
              title="No routes matched"
              description="Adjust the access-tier filter or search query to find a managed route."
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
                    <th className="px-4 py-3 font-medium">Access Tier</th>
                    <th className="px-4 py-3 font-medium">Service</th>
                    <th className="px-4 py-3 font-medium">Auth</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((route) => (
                    <tr
                      key={route.id}
                      onClick={() => openEdit(route)}
                      className="cursor-pointer border-b border-gray-200 transition hover:bg-slate-50/80 dark:border-[#1e1e1e] dark:hover:bg-[#141414]"
                    >
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium text-gray-900 dark:text-white">{route.name}</div>
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{route.file}</p>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap gap-2">
                          {route.hosts.map((host) => (
                            <span key={host} className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-xs text-slate-700 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">{host}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <AccessTierBadge tier={route.accessTier} warning={accessWarning(route, netbirdInstalled)} />
                      </td>
                      <td className="px-4 py-3 align-top text-slate-700 dark:text-slate-300">
                        <div className="font-medium">{route.targetType === "baremetal" ? "Bare-metal" : "K8s Service"}</div>
                        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{buildTargetSummary(route)}</div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span className={cn(
                          "inline-flex rounded-full border px-2.5 py-1 text-xs",
                          route.enableAuth
                            ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
                            : "border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-400",
                        )}>
                          {route.enableAuth ? "Forward auth" : "None"}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top text-right" onClick={(event) => event.stopPropagation()}>
                        <ActionsMenu
                          actions={[
                            { label: "Edit route", onClick: () => openEdit(route) },
                            { label: "Delete route", icon: <Trash2 className="h-4 w-4" />, variant: "destructive", onClick: () => setRouteToDelete(route), disabled: !canWrite },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DashboardPanel>

      <ResponsiveSheet
        open={editorOpen}
        onClose={() => !saving && setEditorOpen(false)}
        title={editingRoute ? `Edit ${editingRoute.name}` : "Add Route"}
        description={editingRoute ? "Update the route manifest and backend target." : "Create a new managed Traefik route and commit it to git."}
        size="lg"
        footer={
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => !saving && setEditorOpen(false)}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] px-4 text-sm text-gray-700 transition hover:bg-gray-100 dark:text-[#d4d4d4] dark:hover:bg-[#1a1a1a]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveRoute()}
              disabled={saving || !canWrite}
              className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-[#3b82f6] px-4 text-sm font-medium text-white transition hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : editingRoute ? "Save changes" : "Create route"}
            </button>
          </div>
        }
      >
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Name</label>
              <input
                value={form.name}
                onChange={(event) => updateForm("name", event.target.value.toLowerCase())}
                disabled={Boolean(editingRoute)}
                placeholder="proxmox"
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Hostname</label>
              <input
                value={form.host}
                onChange={(event) => updateHost(event.target.value)}
                placeholder="proxmox.int.yourdomain.com"
                className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-900 dark:text-white">Access tier</label>
            <div className="grid gap-3 sm:grid-cols-3">
              {(["vpn", "internal", "public"] as AccessTier[]).map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => updateForm("accessTier", tier)}
                  className={cn(
                    "flex items-center justify-between rounded-2xl border px-4 py-3 text-left transition",
                    form.accessTier === tier
                      ? "border-sky-500/30 bg-sky-500/10"
                      : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
                  )}
                >
                  <AccessTierBadge tier={tier} />
                  <span className="text-xs text-slate-500 dark:text-slate-400">{tier === "vpn" ? "NetBird only" : tier === "internal" ? "LAN only" : "Internet"}</span>
                </button>
              ))}
            </div>
            {form.accessTier === "vpn" && !netbirdInstalled ? (
              <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-200">
                NetBird not installed — routes will use internal-only until NetBird is enabled.
              </div>
            ) : null}
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-900 dark:text-white">Target</label>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => updateForm("targetType", "k8s")}
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  form.targetType === "k8s"
                    ? "border-sky-500/30 bg-sky-500/10"
                    : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
                )}
              >
                <p className="font-medium text-gray-900 dark:text-white">K8s Service</p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Create or update a service wrapper in the Traefik namespace.</p>
              </button>
              <button
                type="button"
                onClick={() => updateForm("targetType", "baremetal")}
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  form.targetType === "baremetal"
                    ? "border-sky-500/30 bg-sky-500/10"
                    : "border-gray-200 bg-white hover:bg-slate-50 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:hover:bg-[#141414]",
                )}
              >
                <p className="font-medium text-gray-900 dark:text-white">Bare-metal</p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Create Service + Endpoints for an external IP target.</p>
              </button>
            </div>
          </div>

          {form.targetType === "k8s" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Service name</label>
                <input value={form.targetService} onChange={(event) => updateForm("targetService", event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Namespace</label>
                <input value={form.targetNamespace} onChange={(event) => updateForm("targetNamespace", event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Port</label>
                <input value={form.targetPort} onChange={(event) => updateForm("targetPort", event.target.value)} inputMode="numeric" className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Target IP</label>
                <input value={form.targetIP} onChange={(event) => updateForm("targetIP", event.target.value)} placeholder="192.168.1.100" className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Port</label>
                <input value={form.targetPort} onChange={(event) => updateForm("targetPort", event.target.value)} inputMode="numeric" className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Scheme</label>
                <select value={form.scheme} onChange={(event) => updateForm("scheme", event.target.value as "http" | "https")} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]">
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </div>
            </div>
          )}

          {form.targetType === "baremetal" && form.scheme === "https" ? (
            <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]">
              <input type="checkbox" checked={form.skipTlsVerify} onChange={(event) => updateForm("skipTlsVerify", event.target.checked)} />
              Skip TLS verify
            </label>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]">
              <input type="checkbox" checked={form.enableAuth} onChange={(event) => updateForm("enableAuth", event.target.checked)} />
              Enable Auth
            </label>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">TLS Secret</label>
              <input value={form.tlsSecret} onChange={(event) => updateForm("tlsSecret", event.target.value)} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#3b82f6] dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]" />
            </div>
          </div>
        </div>
      </ResponsiveSheet>

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
