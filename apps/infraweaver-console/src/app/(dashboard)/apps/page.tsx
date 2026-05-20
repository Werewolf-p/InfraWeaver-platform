"use client";

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import {
  Package, FileText, ChevronRight, ChevronLeft, Check, Loader2,
  PlusCircle, Search, ExternalLink, AlertTriangle, Info, CheckCircle,
  Globe, Star, X, Shield, Zap, GitBranch, Eye, Store,
  Terminal, Download, RefreshCw, LayoutGrid, Layers, Settings2,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useSearchParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AccessTierBadge } from "@/components/access-tier-badge";
import { PageHeader } from "@/components/ui/page-header";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { ExportButton } from "@/components/ui/export-button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedBar } from "@/components/ui/segmented-bar";
import { ActionsMenu, type ActionItem } from "@/components/ui/actions-menu";
import { CopyButton } from "@/components/ui/copy-button";
import { useArgoApps } from "@/hooks/use-argocd";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { UpdatePolicyModal } from "@/components/apps/update-policy-modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { usePlatformApps } from "@/hooks/use-platform-apps";
import { resolveAppRouteAccess, type AppRouteAccessSummary } from "@/lib/app-route-access";
import type { AccessTier } from "@/lib/access-tier";



// ── BodyPortal ────────────────────────────────────────────────────────────────
function BodyPortal({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

import { useSimpleMode } from "@/contexts/simple-mode-context";
import { AppCardSkeleton, TableRowSkeleton } from "@/components/ui/skeleton-card";
import { useRBAC } from "@/hooks/use-rbac";

// ── Top-level tab types ────────────────────────────────────────────────────────
type TopTab = "installed" | "catalog" | "community";

// ══════════════════════════════════════════════════════════════════════════════
// ALL INSTALLED TAB
// ══════════════════════════════════════════════════════════════════════════════

type AppHealthStatus = "healthy" | "degraded" | "syncing" | "progressing" | "unknown" | "synced" | "outOfSync";

interface InstalledCommunityApp {
  slug: string;
  name: string;
  description: string;
  namespace: string;
  tier: string;
  image: string;
  categories: string[];
  ingressHost?: string;
  installedAt: string;
  argoAppName: string;
  manifestsPath: string;
}

interface InstalledCommunityAppsResponse {
  apps: InstalledCommunityApp[];
  total: number;
  reason?: "github_token_missing";
}

interface IngressRouteLookup {
  name: string;
  hosts: string[];
  accessTier: AccessTier;
}

interface IngressResponse {
  ingressRoutes: IngressRouteLookup[];
}

// ── Policy badge helpers ───────────────────────────────────────────────────────

type PolicySource = "aciu" | "renovate" | "none";
type PolicySchedule = "continuous" | "daily" | "weekly" | "monthly" | "manual";

interface AppPolicy {
  source: PolicySource;
  schedule?: PolicySchedule;
  enabled?: boolean;
}

function useAppPolicy(slug: string): AppPolicy | null {
  const [policy, setPolicy] = useState<AppPolicy | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/apps/update-policy?app=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: { source?: PolicySource; policy?: { enabled?: boolean; schedule?: PolicySchedule } } | null) => {
        if (!cancelled && d) {
          setPolicy({ source: d.source ?? "none", schedule: d.policy?.schedule, enabled: d.policy?.enabled });
        }
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [slug]);
  return policy;
}

function PolicyBadge({ slug }: { slug: string }) {
  const policy = useAppPolicy(slug);
  if (!policy || policy.source === "none" || !policy.enabled) return null;

  if (policy.source === "aciu") {
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-[10px] font-medium text-blue-400">
        🤖 Continuous
      </span>
    );
  }
  if (policy.source === "renovate") {
    const label = policy.schedule === "manual" ? "Manual" : policy.schedule
      ? policy.schedule.charAt(0).toUpperCase() + policy.schedule.slice(1)
      : "Scheduled";
    const emoji = policy.schedule === "manual" ? "👤" : "📅";
    return (
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-violet-500/30 bg-violet-500/10 text-[10px] font-medium text-violet-400">
        {emoji} {label}
      </span>
    );
  }
  return null;
}

function toHealthStatus(val: string): AppHealthStatus {
  const v = val.toLowerCase();
  const MAP: Record<string, AppHealthStatus> = {
    healthy: "healthy", degraded: "degraded", progressing: "progressing",
    syncing: "syncing", synced: "synced", outofsync: "outOfSync", unknown: "unknown",
  };
  return MAP[v] ?? "unknown";
}

interface AppRow {
  id: string;
  name: string;
  namespace: string;
  health: AppHealthStatus;
  syncStatus: AppHealthStatus;
  source: "Catalog" | "Community";
  lastSync: string;
  createdAt?: string;
  sourceType: "Helm" | "Git" | "Community";
  ingressHost?: string;
  urls?: string[];
  access?: AppRouteAccessSummary;
}

type AppHealthFilter = "all" | "healthy" | "degraded" | "syncing" | "unknown";
type AppSyncFilter = "all" | "synced" | "outOfSync" | "syncing";
type AppSourceFilter = "all" | "Catalog" | "Community";
type AppSortOption = "name-asc" | "name-desc" | "last-synced" | "health";

const APP_HEALTH_FILTERS: Array<{ value: AppHealthFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "healthy", label: "Healthy" },
  { value: "degraded", label: "Degraded" },
  { value: "syncing", label: "Syncing" },
  { value: "unknown", label: "Unknown" },
];

const APP_SYNC_FILTERS: Array<{ value: AppSyncFilter; label: string }> = [
  { value: "all", label: "Any sync" },
  { value: "synced", label: "Synced" },
  { value: "outOfSync", label: "Out of sync" },
  { value: "syncing", label: "Syncing" },
];

const APP_SOURCE_FILTERS: Array<{ value: AppSourceFilter; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "Catalog", label: "Catalog" },
  { value: "Community", label: "Community" },
];

function healthBucket(status: AppHealthStatus): AppHealthFilter {
  if (status === "healthy" || status === "synced") return "healthy";
  if (status === "degraded" || status === "outOfSync") return "degraded";
  if (status === "syncing" || status === "progressing") return "syncing";
  return "unknown";
}

function healthSortValue(status: AppHealthStatus): number {
  const bucket = healthBucket(status);
  return bucket === "degraded" ? 0 : bucket === "syncing" ? 1 : bucket === "unknown" ? 2 : 3;
}

function primaryAppUrl(row: AppRow): string | null {
  return row.urls?.[0] ?? (row.ingressHost ? `https://${row.ingressHost}` : null);
}

const DEFAULT_INTERNAL_DOMAIN = "int.yourdomain.com";

function argocdAppUrl(row: AppRow): string {
  return `https://argocd.${DEFAULT_INTERNAL_DOMAIN}/applications/${encodeURIComponent(row.namespace)}/${encodeURIComponent(row.name)}`;
}

function isProtectedCatalogApp(name: string): boolean {
  return name.startsWith("core-") || name === "bootstrap" || name.startsWith("appset-") || name === "catalog-infraweaver-console-manifests";
}

function AppAccessBadges({ access, netbirdInstalled }: { access?: AppRouteAccessSummary; netbirdInstalled: boolean }) {
  if (!access || access.tiers.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {access.tiers.map((tier) => {
        const matchedHosts = access.matches.filter((match) => match.tier === tier).map((match) => match.host).filter((host): host is string => Boolean(host));
        const warning = tier === "vpn" && !netbirdInstalled ? "VPN required — NetBird not installed" : null;
        const tooltip = matchedHosts.length > 0 ? `${matchedHosts.join(", ")} — ${tier.toUpperCase()} access` : `${tier.toUpperCase()} access`;
        return <AccessTierBadge key={tier} tier={tier} compact warning={warning} tooltip={tooltip} />;
      })}
    </div>
  );
}

function SwipeableAppCard({
  row,
  syncingApp,
  deletingApp,
  onSync,
  onDelete,
  isOptimisticSyncing,
  canSync,
  canDelete,
  actions,
  netbirdInstalled,
}: {
  row: AppRow;
  syncingApp: string | null;
  deletingApp: string | null;
  onSync: (name: string) => void;
  onDelete: (name: string) => void;
  isOptimisticSyncing?: boolean;
  canSync: boolean;
  canDelete: boolean;
  actions: ActionItem[];
  netbirdInstalled: boolean;
}) {
  const x = useMotionValue(0);
  const isCatalog = row.source === "Catalog";
  const quickUrl = primaryAppUrl(row);
  const argocdUrl = argocdAppUrl(row);

  const syncOpacity = useTransform(x, [0, 80], [0, 1]);
  const deleteOpacity = useTransform(x, [-80, 0], [1, 0]);

  const handleDragEnd = (_: unknown, info: { offset: { x: number } }) => {
    if (!isCatalog || (!canSync && !canDelete)) return;
    if (info.offset.x > 80 && canSync) {
      void onSync(row.name);
    } else if (info.offset.x < -80 && canDelete) {
      void onDelete(row.name);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* Behind: Sync (right swipe) */}
      {isCatalog && (
        <motion.div
          style={{ opacity: syncOpacity }}
          className="absolute inset-0 bg-green-500/20 flex items-center pl-5 rounded-xl"
        >
          <RefreshCw className="w-5 h-5 text-green-400" />
          <span className="ml-2 text-xs font-medium text-green-400">Sync</span>
        </motion.div>
      )}
      {/* Behind: Delete (left swipe) */}
      {isCatalog && (
        <motion.div
          style={{ opacity: deleteOpacity }}
          className="absolute inset-0 bg-red-500/20 flex items-center justify-end pr-5 rounded-xl"
        >
          <span className="mr-2 text-xs font-medium text-red-400">Delete</span>
          <X className="w-5 h-5 text-red-400" />
        </motion.div>
      )}
      {/* Card */}
      <motion.div
        style={{ x }}
        drag={isCatalog && (canSync || canDelete) ? "x" : false}
        dragConstraints={{ left: -100, right: 100 }}
        dragElastic={0.1}
        onDragEnd={handleDragEnd}
        whileTap={{ cursor: "grabbing" }}
        className="bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] rounded-xl p-4 relative z-10 touch-manipulation"
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0 mr-3">
            <Link href={`/apps/${encodeURIComponent(row.name)}`} className="block truncate text-sm font-medium text-gray-900 dark:text-[#f2f2f2] transition hover:text-[#7cb9ff]">{row.name}</Link>
            <p className="text-xs text-gray-500 dark:text-[#9e9e9e] font-mono truncate mt-0.5">{row.namespace}</p>
            {(row.ingressHost || row.access?.tiers.length) && (
              <div className="flex items-center gap-1.5 mt-1">
                {row.ingressHost ? (
                  <a
                    href={`https://${row.ingressHost}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={row.access?.tiers.includes("vpn") ? `${row.ingressHost} — requires NetBird VPN` : row.ingressHost}
                    className="flex items-center gap-1 text-xs text-[#4a9eff] hover:text-[#7cb9ff] transition-colors"
                    onClick={e => e.stopPropagation()}
                  >
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate font-mono">{row.ingressHost}</span>
                  </a>
                ) : null}
                <AppAccessBadges access={row.access} netbirdInstalled={netbirdInstalled} />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {quickUrl && (
              <a
                href={quickUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="Open app URL"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 transition hover:text-gray-900 dark:hover:text-white"
              >
                <Globe className="h-3.5 w-3.5" />
              </a>
            )}
            <a
              href={argocdUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in ArgoCD"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex min-h-[36px] min-w-[36px] items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 transition hover:text-gray-900 dark:hover:text-white"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <ActionsMenu actions={actions} className="shrink-0" />
            <StatusBadge status={isOptimisticSyncing ? "syncing" : row.health} />
          </div>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <StatusBadge status={row.syncStatus} />
          <span className={cn(
            "px-2 py-0.5 rounded text-xs font-medium",
            row.source === "Catalog"
              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
              : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
          )}>
            {row.source}
          </span>
          <span className="text-[11px] text-slate-500">
            {row.lastSync ? <RelativeTime date={row.lastSync} className="text-[11px] text-slate-500" /> : "Never synced"}
          </span>
        </div>
      </motion.div>
    </div>
  );
}

function AllInstalledTab() {
  const { can } = useRBAC();
  const canSyncApps = can("apps:sync");
  const canManageApps = can("apps:write");
  const platformApps = usePlatformApps();
  const netbirdInstalled = platformApps.netbird;
  const { data: argoApps, isLoading: argoLoading, isFetching: argoFetching, refetch, dataUpdatedAt, error: argoError, dataSource } = useArgoApps();
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [healthFilter, setHealthFilter] = useState<AppHealthFilter>("all");
  const [syncFilter, setSyncFilter] = useState<AppSyncFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<AppSourceFilter>("all");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [sortOption, setSortOption] = useState<AppSortOption>("health");
  const [syncingApp, setSyncingApp] = useState<string | null>(null);
  const [deletingApp, setDeletingApp] = useState<string | null>(null);
  const [uninstallingApp, setUninstallingApp] = useState<string | null>(null);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkHardRefreshing, setBulkHardRefreshing] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkUninstalling, setBulkUninstalling] = useState(false);
  const [optimisticSyncing, setOptimisticSyncing] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [updatePolicyApp, setUpdatePolicyApp] = useState<{ name: string; slug: string } | null>(null);
  const [recentlyUninstalled, setRecentlyUninstalled] = useState<Set<string>>(new Set());
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description?: string;
    confirmText?: string;
    onConfirm: () => void;
    danger?: boolean;
  }>({ open: false, title: "", confirmText: "Yes, proceed", onConfirm: () => {} });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSearch("");
        setHealthFilter("all");
        setSyncFilter("all");
        setSourceFilter("all");
        setNamespaceFilter("all");
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const communityAppsQuery = useQuery<InstalledCommunityAppsResponse>({
    queryKey: ["community-installed-apps"],
    queryFn: async () => {
      const response = await fetch("/api/community-apps/installed");
      return response.ok ? response.json() : { apps: [], total: 0 };
    },
    staleTime: 30_000,
  });
  const ingressQuery = useQuery<IngressResponse>({
    queryKey: ["ingress-routes", "apps"],
    queryFn: async () => {
      const response = await fetch("/api/ingress", { cache: "no-store" });
      if (!response.ok) return { ingressRoutes: [] } satisfies IngressResponse;
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const communityApps = useMemo(() => communityAppsQuery.data?.apps ?? [], [communityAppsQuery.data?.apps]);
  const communityLoading = communityAppsQuery.isLoading;
  const ingressRoutes = useMemo(() => ingressQuery.data?.ingressRoutes ?? [], [ingressQuery.data?.ingressRoutes]);

  const allRows = useMemo(() => {
    const argoByName = new Map((argoApps ?? []).map(app => [app.metadata?.name ?? "", app]));
    const communityArgoNames = new Set(communityApps.map(app => app.argoAppName));
    const routeLookup = ingressRoutes.map(route => ({
      name: route.name,
      hosts: route.hosts,
      accessTier: route.accessTier,
    }));

    const argo = (argoApps ?? [])
      .filter(app => !communityArgoNames.has(app.metadata?.name ?? ""))
      .filter(app => !recentlyUninstalled.has(app.metadata?.name ?? ""))
      .map(app => {
        const access = resolveAppRouteAccess(routeLookup, {
          name: app.metadata?.name ?? "",
          argoName: app.metadata?.name ?? "",
          urls: app.status?.summary?.externalURLs ?? [],
        });
        return {
          id: app.metadata?.name ?? "",
          name: app.metadata?.name ?? "",
          namespace: app.spec?.destination?.namespace ?? "",
          health: toHealthStatus(app.status?.health?.status ?? "Unknown"),
          syncStatus: toHealthStatus(app.status?.sync?.status ?? "Unknown"),
          source: "Catalog" as const,
          lastSync: app.status?.reconciledAt ?? "",
          createdAt: app.metadata?.creationTimestamp ?? "",
          sourceType: (app.spec?.source?.repoURL?.includes("charts") ? "Helm" : "Git") as "Helm" | "Git",
          ingressHost: access.primaryHost ?? undefined,
          urls: app.status?.summary?.externalURLs ?? [],
          access,
        };
      });

    const community = communityApps.map(app => {
      const argoApp = argoByName.get(app.argoAppName);
      const urls = argoApp?.status?.summary?.externalURLs ?? (app.ingressHost ? [`https://${app.ingressHost}`] : []);
      const access = resolveAppRouteAccess(routeLookup, {
        name: app.slug,
        argoName: app.argoAppName,
        ingressHost: app.ingressHost,
        urls,
      });
      return {
        id: `community-${app.slug}`,
        name: app.slug,
        namespace: app.namespace,
        health: argoApp
          ? toHealthStatus(argoApp.status?.health?.status ?? "Unknown")
          : "unknown" as AppHealthStatus,
        syncStatus: argoApp
          ? toHealthStatus(argoApp.status?.sync?.status ?? "Unknown")
          : "unknown" as AppHealthStatus,
        source: "Community" as const,
        lastSync: argoApp?.status?.reconciledAt ?? app.installedAt,
        createdAt: app.installedAt,
        sourceType: "Community" as const,
        ingressHost: access.primaryHost ?? app.ingressHost,
        urls,
        access,
      };
    });

    return [...argo, ...community];
  }, [argoApps, communityApps, ingressRoutes, recentlyUninstalled]);

  const namespaceOptions = useMemo(
    () => Array.from(new Set(allRows.map(row => row.namespace).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [allRows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...allRows]
      .filter((row) => {
        const matchesSearch = !q || row.name.toLowerCase().includes(q) || row.namespace.toLowerCase().includes(q) || row.ingressHost?.toLowerCase().includes(q);
        const matchesHealth = healthFilter === "all" || healthBucket(row.health) === healthFilter;
        const matchesSync = syncFilter === "all"
          || (syncFilter === "synced" && row.syncStatus === "synced")
          || (syncFilter === "outOfSync" && row.syncStatus === "outOfSync")
          || (syncFilter === "syncing" && ["syncing", "progressing"].includes(row.syncStatus));
        const matchesSource = sourceFilter === "all" || row.source === sourceFilter;
        const matchesNamespace = namespaceFilter === "all" || row.namespace === namespaceFilter;
        return matchesSearch && matchesHealth && matchesSync && matchesSource && matchesNamespace;
      })
      .sort((a, b) => {
        if (sortOption === "name-desc") return b.name.localeCompare(a.name);
        if (sortOption === "last-synced") return new Date(b.lastSync || 0).getTime() - new Date(a.lastSync || 0).getTime();
        if (sortOption === "health") {
          const diff = healthSortValue(a.health) - healthSortValue(b.health);
          return diff !== 0 ? diff : a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
      });
  }, [allRows, healthFilter, namespaceFilter, search, sortOption, sourceFilter, syncFilter]);

  const activeSelectedIds = useMemo(
    () => new Set([...selectedIds].filter(id => allRows.some(row => row.id === id))),
    [allRows, selectedIds],
  );

  const selectedRows = useMemo(
    () => filtered.filter(row => activeSelectedIds.has(row.id)),
    [activeSelectedIds, filtered],
  );

  const selectedCatalogRows = useMemo(
    () => selectedRows.filter(row => row.source === "Catalog"),
    [selectedRows],
  );

  const selectedDeletableCatalogRows = useMemo(
    () => selectedCatalogRows.filter(row => !isProtectedCatalogApp(row.name)),
    [selectedCatalogRows],
  );

  const selectedCommunityRows = useMemo(
    () => selectedRows.filter(row => row.source === "Community"),
    [selectedRows],
  );

  const summary = useMemo(() => ({
    total: allRows.length,
    healthy: allRows.filter(row => healthBucket(row.health) === "healthy").length,
    degraded: allRows.filter(row => healthBucket(row.health) === "degraded").length,
    syncing: allRows.filter(row => ["syncing", "progressing"].includes(row.syncStatus)).length,
    outOfSync: allRows.filter(row => row.syncStatus === "outOfSync").length,
    catalog: allRows.filter(row => row.source === "Catalog").length,
    community: allRows.filter(row => row.source === "Community").length,
  }), [allRows]);

  const loading = argoLoading || communityLoading;
  const hasActiveFilters = Boolean(search.trim()) || healthFilter !== "all" || syncFilter !== "all" || sourceFilter !== "all" || namespaceFilter !== "all";

  const syncOne = async (name: string) => {
    const res = await fetch(`/api/argocd/apps/${encodeURIComponent(name)}/sync`, { method: "POST" });
    if (!res.ok) throw new Error("Sync failed");
  };

  const hardRefreshOne = async (name: string) => {
    const res = await fetch(`/api/argocd/hard-refresh/${encodeURIComponent(name)}`, { method: "POST" });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? "Hard refresh failed");
  };

  const deleteCatalogAppOne = async (name: string) => {
    const res = await fetch(`/api/argocd/apps/${encodeURIComponent(name)}/delete`, { method: "DELETE" });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? "Delete failed");
  };

  const uninstallCommunityAppOne = async (slug: string) => {
    const res = await fetch(`/api/community-apps/${encodeURIComponent(slug)}`, { method: "DELETE" });
    const data = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) throw new Error(data?.error ?? "Uninstall failed");
  };

  const handleSync = async (name: string) => {
    if (!canSyncApps) {
      toast.error("You do not have permission to sync apps");
      return;
    }
    setSyncingApp(name);
    setOptimisticSyncing(prev => new Set([...prev, name]));
    try {
      await syncOne(name);
      toast.success(`Syncing ${name}…`);
      setTimeout(() => void refetch(), 2000);
    } catch {
      toast.error(`Failed to sync ${name}`);
    } finally {
      setSyncingApp(null);
      setOptimisticSyncing(prev => { const next = new Set(prev); next.delete(name); return next; });
    }
  };

  const requestSync = (name: string) => {
    if (!canSyncApps) {
      toast.error("You do not have permission to sync apps");
      return;
    }
    setConfirmDialog({
      open: true,
      title: `Force sync "${name}"?`,
      description: "This asks ArgoCD to reconcile the application immediately.",
      confirmText: "Force sync",
      onConfirm: () => {
        setConfirmDialog(dialog => ({ ...dialog, open: false }));
        void handleSync(name);
      },
    });
  };

  const handleBulkSync = async () => {
    if (!canSyncApps) {
      toast.error("You do not have permission to sync apps");
      return;
    }
    const targets = selectedCatalogRows;
    if (targets.length === 0) {
      toast.error("Select at least one catalog app to bulk sync");
      return;
    }
    setBulkSyncing(true);
    setOptimisticSyncing(prev => new Set([...prev, ...targets.map(target => target.name)]));
    const results = await Promise.allSettled(targets.map(target => syncOne(target.name)));
    const ok = results.filter(result => result.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`Queued sync for ${ok} app${ok === 1 ? "" : "s"}`);
    if (failed > 0) toast.error(`${failed} app${failed === 1 ? "" : "s"} failed to sync`);
    setBulkSyncing(false);
    setSelectedIds(new Set());
    setOptimisticSyncing(prev => {
      const next = new Set(prev);
      for (const target of targets) next.delete(target.name);
      return next;
    });
    void refetch();
  };

  const requestBulkSync = () => {
    const targets = selectedCatalogRows;
    if (targets.length === 0) {
      toast.error("Select at least one catalog app to bulk sync");
      return;
    }
    setConfirmDialog({
      open: true,
      title: `Force sync ${targets.length} selected app${targets.length === 1 ? "" : "s"}?`,
      description: "This queues an immediate sync for every selected catalog app.",
      confirmText: "Sync selected apps",
      onConfirm: () => {
        setConfirmDialog(dialog => ({ ...dialog, open: false }));
        void handleBulkSync();
      },
    });
  };

  const handleBulkHardRefresh = async () => {
    if (!canSyncApps) {
      toast.error("You do not have permission to hard-refresh apps");
      return;
    }
    const targets = selectedCatalogRows;
    if (!targets.length) {
      toast.error("Select at least one catalog app");
      return;
    }
    setBulkHardRefreshing(true);
    const results = await Promise.allSettled(targets.map(target => hardRefreshOne(target.name)));
    const ok = results.filter(result => result.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`Hard-refreshed ${ok} app${ok === 1 ? "" : "s"}`);
    if (failed > 0) toast.error(`${failed} app${failed === 1 ? "" : "s"} failed to hard-refresh`);
    setBulkHardRefreshing(false);
    setSelectedIds(new Set());
    void refetch();
  };

  const handleBulkDelete = async (targets: AppRow[]) => {
    if (!canManageApps) {
      toast.error("You do not have permission to delete apps");
      return;
    }
    if (!targets.length) {
      toast.error("No deletable catalog apps selected");
      return;
    }
    setBulkDeleting(true);
    const results = await Promise.allSettled(targets.map(target => deleteCatalogAppOne(target.name)));
    const ok = results.filter(result => result.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok > 0) toast.success(`Deleted ${ok} app${ok === 1 ? "" : "s"}`);
    if (failed > 0) toast.error(`${failed} app${failed === 1 ? "" : "s"} failed to delete`);
    setBulkDeleting(false);
    setSelectedIds(new Set());
    void refetch();
  };

  const requestBulkDelete = () => {
    if (!canManageApps) {
      toast.error("You do not have permission to delete apps");
      return;
    }
    const targets = selectedDeletableCatalogRows;
    if (!targets.length) {
      toast.error("No deletable catalog apps selected");
      return;
    }
    setConfirmDialog({
      open: true,
      title: `Delete ${targets.length} app${targets.length === 1 ? "" : "s"}?`,
      description: `This removes ${targets.length} apps from ArgoCD. Kubernetes resources may remain.`,
      confirmText: "Delete selected",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(dialog => ({ ...dialog, open: false }));
        void handleBulkDelete(targets);
      },
    });
  };

  const handleBulkCommunityUninstall = async (targets: AppRow[]) => {
    if (!canManageApps) {
      toast.error("You do not have permission to uninstall community apps");
      return;
    }
    if (!targets.length) {
      toast.error("No community apps selected");
      return;
    }
    setBulkUninstalling(true);
    const results = await Promise.allSettled(targets.map(target => uninstallCommunityAppOne(target.name)));
    const ok = results.filter(result => result.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok > 0) {
      toast.success(`Uninstalled ${ok} community app${ok === 1 ? "" : "s"}`);
      setRecentlyUninstalled(prev => new Set([...prev, ...targets.map(target => `catalog-${target.name}-manifests`)]));
    }
    if (failed > 0) toast.error(`${failed} community app${failed === 1 ? "" : "s"} failed to uninstall`);
    setBulkUninstalling(false);
    setSelectedIds(new Set());
    void communityAppsQuery.refetch();
    void refetch();
  };

  const requestBulkCommunityUninstall = () => {
    if (!canManageApps) {
      toast.error("You do not have permission to uninstall community apps");
      return;
    }
    const targets = selectedCommunityRows;
    if (!targets.length) {
      toast.error("No community apps selected");
      return;
    }
    setConfirmDialog({
      open: true,
      title: `Uninstall ${targets.length} community app${targets.length === 1 ? "" : "s"}?`,
      description: "This removes the selected community apps from git. ArgoCD will clean up deployed resources within a few minutes.",
      confirmText: "Uninstall selected",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(dialog => ({ ...dialog, open: false }));
        void handleBulkCommunityUninstall(targets);
      },
    });
  };

  const openExternal = (href: string) => {
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const buildRowActions = (row: AppRow): ActionItem[] => {
    const actions: ActionItem[] = [];
    const appUrl = primaryAppUrl(row);

    if (appUrl) {
      actions.push({
        label: "Open app URL",
        icon: <Globe className="h-4 w-4" />,
        onClick: () => openExternal(appUrl),
      });
    }

    actions.push({
      label: "Open in ArgoCD",
      icon: <ExternalLink className="h-4 w-4" />,
      onClick: () => openExternal(argocdAppUrl(row)),
    });

    if (row.source === "Catalog") {
      actions.push({
        label: "Update policy",
        icon: <Settings2 className="h-4 w-4" />,
        onClick: () => setUpdatePolicyApp({ name: row.name, slug: row.name }),
        disabled: !canManageApps,
      });
      actions.push({
        label: syncingApp === row.name ? "Syncing…" : "Force sync",
        icon: <RefreshCw className="h-4 w-4" />,
        onClick: () => requestSync(row.name),
        disabled: syncingApp === row.name || !canSyncApps,
      });
      actions.push({
        label: deletingApp === row.name ? "Deleting…" : "Delete",
        icon: <X className="h-4 w-4" />,
        onClick: () => void handleDelete(row.name),
        variant: "destructive",
        disabled: deletingApp === row.name || !canManageApps,
      });
      return actions;
    }

    actions.push({
      label: uninstallingApp === row.name ? "Uninstalling…" : "Uninstall",
      icon: <X className="h-4 w-4" />,
      onClick: () => void handleUninstallCommunity(row.name),
      variant: "destructive",
      disabled: uninstallingApp === row.name || !canManageApps,
    });

    return actions;
  };

  const handleDelete = async (name: string) => {
    if (!canManageApps) {
      toast.error("You do not have permission to delete apps");
      return;
    }

    const isCoreApp = isProtectedCatalogApp(name);
    if (isCoreApp) {
      toast.error(`"${name}" is core infrastructure and cannot be removed from the console.`);
      return;
    }

    const isCatalogOrPlatform = name.startsWith("catalog-") || name.startsWith("platform-");
    const description = isCatalogOrPlatform
      ? "This removes the app's git files and ArgoCD application. Deployed resources will be cleaned up by ArgoCD. This cannot be undone."
      : "This permanently removes the ArgoCD application and cannot be undone. Deployed resources will be cleaned up automatically.";

    setConfirmDialog({
      open: true,
      title: `Remove "${name}"?`,
      description,
      confirmText: "Delete app",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(d => ({ ...d, open: false }));
        setDeletingApp(name);

        const endpoint = isCatalogOrPlatform
          ? `/api/apps/${encodeURIComponent(name)}/uninstall`
          : `/api/argocd/apps/${encodeURIComponent(name)}/delete`;

        fetch(endpoint, { method: "DELETE" })
          .then(res => res.json().then(data => ({ ok: res.ok, data })))
          .then(({ ok, data }: { ok: boolean; data: { message?: string; error?: string } }) => {
            if (!ok) throw new Error(data.error ?? "Remove failed");
            toast.success(data.message ?? `Removed ${name}`);
            void refetch();
          })
          .catch((e: unknown) => toast.error(e instanceof Error ? e.message : `Failed to remove ${name}`))
          .finally(() => setDeletingApp(null));
      },
    });
  };

  const handleUninstallCommunity = async (slug: string) => {
    if (!canManageApps) {
      toast.error("You do not have permission to uninstall community apps");
      return;
    }
    setConfirmDialog({
      open: true,
      title: `Uninstall "${slug}"?`,
      description: "This removes the app from git. ArgoCD will clean up deployed resources within a few minutes.",
      confirmText: "Uninstall app",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(d => ({ ...d, open: false }));
        setUninstallingApp(slug);
        fetch(`/api/community-apps/${encodeURIComponent(slug)}`, { method: "DELETE" })
          .then(r => r.json())
          .then((data: { message?: string; error?: string; details?: string[] }) => {
            toast.success(data.message ?? `${slug} scheduled for removal`);
            void communityAppsQuery.refetch();
            setRecentlyUninstalled(prev => new Set([...prev, `catalog-${slug}-manifests`]));
          })
          .catch(e => toast.error(String(e)))
          .finally(() => setUninstallingApp(null));
      },
    });
  };

  const exportRows = async (format: "csv" | "json" | "yaml") => {
    const rows = filtered.map((row) => ({
      name: row.name,
      namespace: row.namespace,
      source: row.source,
      health: row.health,
      syncStatus: row.syncStatus,
      lastSync: row.lastSync || "",
      createdAt: row.createdAt || "",
      ingressHost: row.ingressHost || "",
    }));
    if (format === "json") return JSON.stringify(rows, null, 2);
    const headers = ["name", "namespace", "source", "health", "syncStatus", "lastSync", "createdAt", "ingressHost"];
    const csv = [headers.join(","), ...rows.map(row => headers.map(key => JSON.stringify(row[key as keyof typeof row] ?? "")).join(","))].join("\n");
    if (format === "yaml") {
      return rows.map(row => `- name: ${row.name}\n  namespace: ${row.namespace}\n  source: ${row.source}\n  health: ${row.health}\n  syncStatus: ${row.syncStatus}\n  lastSync: ${row.lastSync}\n  createdAt: ${row.createdAt}\n  ingressHost: ${row.ingressHost}`).join("\n");
    }
    return csv;
  };

  const toggleSelected = (id: string) => {
    setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => {
    if (filtered.length === 0) return;
    const allSelected = filtered.every(row => selectedIds.has(row.id));
    setSelectedIds(allSelected ? new Set() : new Set(filtered.map(row => row.id)));
  };

  const { simpleMode, toggle } = useSimpleMode();

  return (
    <div className="space-y-5">
      <DashboardPanel
        title="Application health overview"
        description="Prioritized health, sync drift, and deployment freshness before the full table."
        icon={LayoutGrid}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportButton getData={exportRows} filename="apps-overview" formats={["csv", "json"]} />
            <RefreshCountdown intervalSeconds={30} resetKey={dataUpdatedAt} />
          </div>
        }
      >
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
            <DashboardStatCard label="Installed apps" value={summary.total} icon={Layers} tone="info" description="Catalog and community apps currently visible to the operator." footer={<span>{summary.catalog} catalog · {summary.community} community</span>} />
            <DashboardStatCard label="Healthy" value={summary.healthy} icon={CheckCircle} tone={summary.degraded > 0 ? "warning" : "success"} description="Apps reporting healthy/synced state." footer={<span>{summary.degraded} degraded or out-of-sync</span>} />
            <DashboardStatCard label="Syncing" value={summary.syncing} icon={RefreshCw} tone={summary.syncing > 0 ? "warning" : "neutral"} description="Applications actively progressing or syncing." footer={<span>{summary.outOfSync} out of sync</span>} />
            <DashboardStatCard label="Selected" value={activeSelectedIds.size} icon={Package} tone={activeSelectedIds.size > 0 ? "info" : "neutral"} description="Desktop bulk actions work on the current filtered result set." footer={<span>{selectedCatalogRows.length} catalog · {selectedCommunityRows.length} community selected</span>} />
          </div>
          <div className="rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#141414] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Health distribution</p>
                <p className="text-xs text-gray-500 dark:text-[#888]">Quick read of app health without scanning the whole table.</p>
              </div>
              <button
                onClick={() => void refetch()}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-3 py-1.5 text-xs text-gray-500 dark:text-[#9e9e9e] transition hover:text-gray-900 dark:hover:text-white"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", (loading || argoFetching) && "animate-spin")} />
                Refresh
              </button>
            </div>
            <div className="mt-4 space-y-3">
              <SegmentedBar
                segments={[
                  { label: "Healthy", value: summary.healthy, className: "bg-emerald-500" },
                  { label: "Degraded", value: summary.degraded, className: "bg-amber-500" },
                  { label: "Syncing", value: summary.syncing, className: "bg-blue-500" },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  { label: "Healthy", value: summary.healthy, tone: "text-emerald-300" },
                  { label: "Degraded", value: summary.degraded, tone: "text-amber-300" },
                  { label: "Syncing", value: summary.syncing, tone: "text-blue-300" },
                ].map(item => (
                  <div key={item.label} className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-gray-400 dark:text-[#666]">{item.label}</p>
                    <p className={`mt-2 text-2xl font-semibold ${item.tone}`}>{item.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </DashboardPanel>

      <DashboardPanel title="Search, filters & bulk actions" description="Namespace, health, sync, and source filters tuned for dense desktop triage." icon={Search}>
        <div className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <ToolbarSearchInput
              ref={searchRef}
              value={search}
              onChange={setSearch}
              placeholder="Search app name, namespace, or ingress host…"
              className="flex-1"
            />
            <select
              value={namespaceFilter}
              onChange={(event) => setNamespaceFilter(event.target.value)}
              className="h-11 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]/50"
            >
              <option value="all">All namespaces</option>
              {namespaceOptions.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
            </select>
            <select
              value={sortOption}
              onChange={(event) => setSortOption(event.target.value as AppSortOption)}
              className="h-11 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]/50"
            >
              <option value="health">Health status</option>
              <option value="last-synced">Last synced</option>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
            </select>
            <button
              onClick={toggle}
              className={cn(
                "flex h-11 items-center gap-1.5 rounded-xl border px-4 text-xs font-medium transition-colors",
                simpleMode
                  ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
                  : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
              )}
            >
              {simpleMode ? "Simple" : "Advanced"}
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {APP_HEALTH_FILTERS.map((option) => (
              <button
                key={option.value}
                onClick={() => setHealthFilter(option.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  healthFilter === option.value
                    ? "border-indigo-500/30 bg-indigo-500/15 text-indigo-300"
                    : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            {APP_SYNC_FILTERS.map((option) => (
              <button
                key={option.value}
                onClick={() => setSyncFilter(option.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  syncFilter === option.value
                    ? "border-blue-500/30 bg-blue-500/15 text-blue-200"
                    : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                {option.label}
              </button>
            ))}
            {APP_SOURCE_FILTERS.map((option) => (
              <button
                key={option.value}
                onClick={() => setSourceFilter(option.value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  sourceFilter === option.value
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-200"
                    : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white"
                )}
              >
                {option.label}
              </button>
            ))}
            {hasActiveFilters && (
              <button
                onClick={() => { setSearch(""); setHealthFilter("all"); setSyncFilter("all"); setSourceFilter("all"); setNamespaceFilter("all"); }}
                className="rounded-full border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 transition-colors hover:text-gray-900 dark:hover:text-white"
              >
                Clear filters
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-3 text-sm text-gray-500 dark:text-[#9e9e9e]">
            <span>{filtered.length} of {allRows.length} app(s) shown</span>
            <div className="h-4 w-px bg-gray-100 dark:bg-[#2a2a2a]" />
            <button onClick={selectAllVisible} className="text-[#9dcbff] transition hover:text-gray-900 dark:hover:text-white">
              {filtered.length > 0 && filtered.every(row => selectedIds.has(row.id)) ? "Clear visible selection" : "Select visible"}
            </button>
            <div className="h-4 w-px bg-gray-100 dark:bg-[#2a2a2a]" />
            <span>{activeSelectedIds.size} selected</span>
            <button onClick={() => setSelectedIds(new Set())} className="text-slate-500 dark:text-slate-400 transition hover:text-gray-900 dark:hover:text-white">Reset selection</button>
            <button
              onClick={requestBulkSync}
              disabled={bulkSyncing || !canSyncApps || selectedCatalogRows.length === 0}
              className="ml-auto inline-flex items-center gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm text-indigo-200 transition hover:bg-indigo-500/20 disabled:opacity-50"
            >
              {bulkSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Bulk sync selected catalog apps
            </button>
            <button
              onClick={() => void handleBulkHardRefresh()}
              disabled={bulkHardRefreshing || !canSyncApps || selectedCatalogRows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-50"
            >
              {bulkHardRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Hard refresh
            </button>
            <button
              onClick={requestBulkDelete}
              disabled={bulkDeleting || !canManageApps || selectedDeletableCatalogRows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
            >
              {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              Delete selected
            </button>
            <button
              onClick={requestBulkCommunityUninstall}
              disabled={bulkUninstalling || !canManageApps || selectedCommunityRows.length === 0}
              className="inline-flex items-center gap-2 rounded-xl border border-fuchsia-500/30 bg-fuchsia-500/10 px-4 py-2 text-sm text-fuchsia-200 transition hover:bg-fuchsia-500/20 disabled:opacity-50"
            >
              {bulkUninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Store className="h-4 w-4" />}
              Uninstall community
            </button>
          </div>
        </div>
      </DashboardPanel>

      {dataSource === "unavailable" && !argoError ? (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <p className="font-medium">ArgoCD unavailable — apps list cannot be loaded. Check ARGOCD_TOKEN and server connectivity.</p>
          </div>
        </div>
      ) : null}

      {argoError ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
            <div className="space-y-3">
              <div>
                <p className="font-semibold">Apps could not be loaded</p>
                <p className="mt-1 text-red-100/85">{argoError instanceof Error ? argoError.message : "Unknown ArgoCD error."}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-red-100/80">
                <Link href="/settings" className="text-[#9dcbff] transition hover:text-gray-900 dark:hover:text-white">Configure ArgoCD</Link>
                <span>Check connectivity to the ArgoCD API and cluster secrets.</span>
                <button type="button" onClick={() => void refetch()} className="text-[#9dcbff] transition hover:text-gray-900 dark:hover:text-white">Retry</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {loading && filtered.length === 0 && (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#666] text-xs">
                  <th className="w-10 py-2 px-3" />
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  {!simpleMode && <th className="text-left py-2 px-3 font-medium">Namespace</th>}
                  <th className="text-left py-2 px-3 font-medium">Health</th>
                  <th className="text-left py-2 px-3 font-medium">Sync</th>
                  <th className="text-left py-2 px-3 font-medium">Source</th>
                  {!simpleMode && <th className="text-left py-2 px-3 font-medium">Timing</th>}
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...Array(5)].map((_, i) => <TableRowSkeleton key={i} />)}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-3">
            {[...Array(4)].map((_, i) => <AppCardSkeleton key={i} />)}
          </div>
        </>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={Layers}
          title="No apps match the current filters"
          description="Adjust the namespace, sync, or health filters to bring apps back into view."
          action={{ label: "Reset filters", onClick: () => { setSearch(""); setHealthFilter("all"); setSyncFilter("all"); setSourceFilter("all"); setNamespaceFilter("all"); } }}
          className="py-12"
        />
      )}

      <div className="hidden md:block overflow-x-auto">
        {filtered.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#666] text-xs">
                <th className="w-10 py-2 px-3">
                  <input type="checkbox" checked={filtered.length > 0 && filtered.every(row => selectedIds.has(row.id))} onChange={selectAllVisible} />
                </th>
                <th className="text-left py-2 px-3 font-medium">Name</th>
                {!simpleMode && <th className="text-left py-2 px-3 font-medium">Namespace</th>}
                <th className="text-left py-2 px-3 font-medium">Health</th>
                <th className="text-left py-2 px-3 font-medium">Sync</th>
                <th className="text-left py-2 px-3 font-medium">Source</th>
                {!simpleMode && <th className="text-left py-2 px-3 font-medium">Timing</th>}
                <th className="text-right py-2 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <tr key={row.id} className={cn("border-b border-gray-200 dark:border-[#1e1e1e] transition-colors", selectedIds.has(row.id) ? "bg-[rgba(0,120,212,0.06)]" : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a]")}>
                  <td className="py-2.5 px-3 align-top">
                    <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row.id)} />
                  </td>
                  <td className="py-2.5 px-3 font-medium text-gray-900 dark:text-[#f2f2f2] align-top">
                    <div className="flex items-center gap-2">
                      <Link href={`/apps/${encodeURIComponent(row.name)}`} className="transition hover:text-[#7cb9ff]">{row.name}</Link>
                      <CopyButton text={row.name} className="h-7 px-2 text-[11px]" />
                      {primaryAppUrl(row) && (
                        <a href={primaryAppUrl(row) ?? undefined} target="_blank" rel="noopener noreferrer" title="Open app URL" className="text-[#4a9eff] hover:text-[#7cb9ff] transition-colors" onClick={e => e.stopPropagation()}>
                          <Globe className="w-3 h-3" />
                        </a>
                      )}
                      <a href={argocdAppUrl(row)} target="_blank" rel="noopener noreferrer" title="Open in ArgoCD" className="text-slate-500 hover:text-gray-900 dark:hover:text-white transition-colors" onClick={e => e.stopPropagation()}>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {row.ingressHost && <p className="text-xs text-[#4a9eff] font-mono truncate max-w-[240px]">{row.ingressHost}</p>}
                      <AppAccessBadges access={row.access} netbirdInstalled={netbirdInstalled} />
                      {row.createdAt && <span className="text-xs text-gray-400 dark:text-[#666]"><RelativeTime date={row.createdAt} live={false} className="text-xs text-gray-400 dark:text-[#666]" /></span>}
                    </div>
                  </td>
                  {!simpleMode && <td className="py-2.5 px-3 align-top"><div className="flex items-center gap-2"><span className="font-mono text-xs text-gray-500 dark:text-[#9e9e9e]">{row.namespace}</span><CopyButton text={row.namespace} className="h-7 px-2 text-[11px]" /></div></td>}
                  <td className="py-2.5 px-3 align-top"><StatusBadge status={optimisticSyncing.has(row.name) ? "syncing" : row.health} /></td>
                  <td className="py-2.5 px-3 align-top"><StatusBadge status={row.syncStatus} /></td>
                  <td className="py-2.5 px-3 align-top"><span className={cn("px-2 py-0.5 rounded text-xs font-medium", row.source === "Catalog" ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" : "bg-purple-500/10 text-purple-400 border border-purple-500/20")}>{row.source}</span></td>
                  {!simpleMode && (
                    <td className="py-2.5 px-3 align-top text-xs text-gray-400 dark:text-[#666]">
                      <div>{row.lastSync ? <RelativeTime date={row.lastSync} live={false} className="text-xs text-gray-400 dark:text-[#666]" /> : "Never synced"}</div>
                      <div className="mt-1">{row.lastSync ? new Date(row.lastSync).toLocaleString() : "—"}</div>
                    </td>
                  )}
                  <td className="py-2.5 px-3 text-right align-top">
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      {row.source === "Catalog" ? <PolicyBadge slug={row.name} /> : null}
                      <ActionsMenu actions={buildRowActions(row)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="md:hidden space-y-3">
        <AnimatePresence>
          {filtered.map((row, index) => (
            <motion.div key={row.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * 0.05, 0.25), duration: 0.2 }}>
              <div className="mb-2 flex items-center justify-between rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-xs text-gray-500 dark:text-[#888]">
                <button onClick={() => toggleSelected(row.id)} className={cn("rounded-full border px-2 py-1 transition-colors", selectedIds.has(row.id) ? "border-[#0078D4]/40 bg-[rgba(0,120,212,0.15)] text-[#9dcbff]" : "border-gray-200 dark:border-[#2a2a2a]")}>
                  {selectedIds.has(row.id) ? "Selected" : "Select"}
                </button>
                <span>{row.createdAt ? <RelativeTime date={row.createdAt} live={false} className="text-xs text-gray-500 dark:text-[#888]" /> : "Age unavailable"}</span>
              </div>
              <SwipeableAppCard
                row={row}
                syncingApp={syncingApp}
                deletingApp={deletingApp}
                onSync={requestSync}
                onDelete={handleDelete}
                isOptimisticSyncing={optimisticSyncing.has(row.name)}
                canSync={canSyncApps}
                canDelete={canManageApps}
                actions={buildRowActions(row)}
                netbirdInstalled={netbirdInstalled}
              />
              {row.source === "Catalog" && (
                <div className="mt-2 flex flex-wrap items-center gap-2 px-1">
                  <PolicyBadge slug={row.name} />
                  <button onClick={() => setUpdatePolicyApp({ name: row.name, slug: row.name })} disabled={!canManageApps} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#666] hover:text-[#0078D4] hover:border-[#0078D4]/40 transition-colors min-h-[36px] disabled:opacity-50">
                    <Settings2 className="w-3.5 h-3.5" /> Update Policy
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {updatePolicyApp && (
        <UpdatePolicyModal
          appName={updatePolicyApp.name}
          appSlug={updatePolicyApp.slug}
          open={true}
          onClose={() => setUpdatePolicyApp(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        danger={confirmDialog.danger}
        confirmText={confirmDialog.confirmText ?? "Yes, proceed"}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PLATFORM CATALOG TAB  (catalog-install wizard)
// ══════════════════════════════════════════════════════════════════════════════

type AppType = "helm" | "raw" | null;

interface HelmFields {
  appName: string; namespace: string; helmRepoURL: string;
  chartName: string; chartVersion: string; targetRevision: string; valuesOverride: string;
}

interface RawFields {
  appName: string; namespace: string; gitRepoURL: string;
  gitPath: string; targetRevision: string;
}

interface CatalogAppEntry {
  name: string;
  description: string;
  host: string;
  namespace: string;
}

function generateHelmYaml(f: HelmFields): string {
  const valuesBlock = f.valuesOverride.trim()
    ? `\n    helm:\n      releaseName: ${f.appName}\n      values: |\n${f.valuesOverride.split("\n").map(l => `        ${l}`).join("\n")}`
    : `\n    helm:\n      releaseName: ${f.appName}`;
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: catalog-${f.appName}-manifests
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: infraweaver
spec:
  project: platform
  source:
    repoURL: ${f.helmRepoURL}
    chart: ${f.chartName}
    targetRevision: ${f.chartVersion}${valuesBlock}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${f.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`;
}

function generateRawYaml(f: RawFields): string {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: catalog-${f.appName}-manifests
  namespace: argocd
  labels:
    app.kubernetes.io/part-of: infraweaver
spec:
  project: platform
  source:
    repoURL: ${f.gitRepoURL}
    path: ${f.gitPath}
    targetRevision: ${f.targetRevision}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${f.namespace}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
`;
}

const DEFAULT_GIT_REPO = "https://github.com/your-org/your-repo";
const inputCls = "w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">
        {label}{required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {children}
    </div>
  );
}

// ── Catalog Browse Card ────────────────────────────────────────────────────────
function CatalogBrowseCard({
  app,
  installed,
  onInstall,
  canInstall,
}: {
  app: CatalogAppEntry;
  installed: boolean;
  onInstall: (app: CatalogAppEntry) => void;
  canInstall: boolean;
}) {
  const displayName = app.name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group bg-gray-100 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 flex flex-col gap-3 transition-all duration-200"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-[#0078D4]/20 border border-[#0078D4]/30 flex items-center justify-center flex-shrink-0">
          <Package className="w-4 h-4 text-[#0078D4]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-gray-900 dark:text-white font-medium text-sm truncate">{displayName}</p>
          <p className="text-gray-400 dark:text-white/40 text-[10px] font-mono truncate">{app.name}</p>
        </div>
        {installed && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium text-emerald-400 flex-shrink-0">
            <Check className="w-2.5 h-2.5" /> Installed
          </span>
        )}
      </div>

      {/* Description */}
      {app.description && (
        <p className="text-gray-500 dark:text-white/50 text-xs leading-relaxed line-clamp-2 flex-1">{app.description}</p>
      )}

      {/* Host */}
      {app.host && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10">
          <Globe className="w-3 h-3 text-gray-400 dark:text-white/40 flex-shrink-0" />
          <span className="text-gray-500 dark:text-white/50 text-[10px] font-mono truncate">{app.host}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={() => onInstall(app)}
          disabled={installed || !canInstall}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors min-h-[44px] touch-manipulation",
            installed
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 cursor-default"
              : canInstall
                ? "bg-[#0078D4] hover:bg-[#0066b8] text-white"
                : "bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/10 text-gray-400 dark:text-white/40 cursor-not-allowed"
          )}
        >
          {installed ? <><Check className="w-3 h-3" /> Installed</> : <><Download className="w-3 h-3" /> Install</>}
        </button>
      </div>
    </motion.div>
  );
}

// ── Catalog Browse View ───────────────────────────────────────────────────────
function CatalogBrowseView({
  onInstall,
  onCustom,
  installedNames,
  canInstall,
}: {
  onInstall: (app: CatalogAppEntry) => void;
  onCustom: () => void;
  installedNames: Set<string>;
  canInstall: boolean;
}) {
  const [apps, setApps] = useState<CatalogAppEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch("/api/config/catalog-apps")
      .then(r => r.ok ? r.json() as Promise<CatalogAppEntry[]> : Promise.resolve([] as CatalogAppEntry[]))
      .then(data => { setApps(data.filter(a => a.name !== "_template")); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const filtered = apps.filter(a =>
    !search ||
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) => {
    const ai = installedNames.has(a.name) ? 1 : 0;
    const bi = installedNames.has(b.name) ? 1 : 0;
    if (ai !== bi) return ai - bi; // not installed first
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search catalog apps…"
            className="w-full bg-white dark:bg-[#0f0f0f] border border-gray-200 dark:border-[#333] rounded-lg pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] placeholder:text-gray-400 dark:placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50"
          />
        </div>
        <button
          onClick={onCustom}
          disabled={!canInstall}
          className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-gray-200 dark:border-[#333] px-3 py-2 text-sm text-gray-500 dark:text-[#9e9e9e] transition-colors hover:border-[#555] hover:text-gray-900 dark:hover:text-white sm:w-auto whitespace-nowrap disabled:opacity-50 touch-manipulation"
        >
          <PlusCircle className="w-4 h-4" />
          <span className="hidden sm:inline">Custom URL</span>
        </button>
      </div>

      {/* Counts */}
      {!loading && (
        <p className="text-xs text-gray-400 dark:text-[#666]">
          {sorted.length} app{sorted.length !== 1 ? "s" : ""} in catalog
          {installedNames.size > 0 && ` · ${installedNames.size} installed`}
        </p>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(9)].map((_, i) => (
            <div key={i} className="bg-gray-100 dark:bg-white/[0.03] border border-white/[0.07] rounded-xl p-4 h-36 animate-pulse" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-gray-400 dark:text-[#555]">
          <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No catalog apps found</p>
        </div>
      ) : (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map(app => (
            <CatalogBrowseCard
              key={app.name}
              app={app}
              installed={installedNames.has(app.name)}
              onInstall={onInstall}
              canInstall={canInstall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Catalog Installer (browse + wizard) ───────────────────────────────────────
function CatalogInstallerTab({ onInstalled }: { onInstalled?: () => void }) {
  const { can } = useRBAC();
  const canInstallCatalog = can("catalog:write");
  // "browse" = catalog grid, "wizard" = manual step wizard
  const [mode, setMode] = useState<"browse" | "wizard">("browse");
  const [step, setStep] = useState(1);
  const [appType, setAppType] = useState<AppType>(null);
  const [helmFields, setHelmFields] = useState<HelmFields>({
    appName: "", namespace: "", helmRepoURL: "", chartName: "",
    chartVersion: "", targetRevision: "HEAD", valuesOverride: "",
  });
  const [rawFields, setRawFields] = useState<RawFields>({
    appName: "", namespace: "", gitRepoURL: DEFAULT_GIT_REPO,
    gitPath: "", targetRevision: "HEAD",
  });
  const [commitMessage, setCommitMessage] = useState("");
  const [installing, setInstalling] = useState(false);
  const [success, setSuccess] = useState(false);

  // Pull ArgoCD apps to know what's installed
  const { data: argoApps } = useArgoApps();
  const installedNames = useMemo(() => {
    const names = new Set<string>();
    for (const app of argoApps ?? []) {
      const n = app.metadata?.name ?? "";
      // ArgoCD name pattern: catalog-{appname}-manifests
      const m = n.match(/^catalog-(.+)-manifests$/);
      if (m) names.add(m[1]);
    }
    return names;
  }, [argoApps]);

  const appName = appType === "helm" ? helmFields.appName : rawFields.appName;
  const generatedYaml = appType === "helm"
    ? generateHelmYaml(helmFields)
    : appType === "raw" ? generateRawYaml(rawFields) : "";
  const defaultCommitMessage = `feat: install catalog app ${appName} via InfraWeaver Console`;

  const canProceedStep2 = appType === "helm"
    ? !!(helmFields.appName && helmFields.namespace && helmFields.helmRepoURL && helmFields.chartName && helmFields.chartVersion)
    : !!(rawFields.appName && rawFields.namespace && rawFields.gitRepoURL && rawFields.gitPath);

  // Called when user clicks "Install" on a catalog browse card
  const handleCatalogInstall = (app: CatalogAppEntry) => {
    if (!canInstallCatalog) {
      toast.error("You do not have permission to install catalog apps");
      return;
    }
    setRawFields({
      appName: app.name,
      namespace: app.namespace || app.name,
      gitRepoURL: DEFAULT_GIT_REPO,
      gitPath: `kubernetes/catalog/${app.name}`,
      targetRevision: "HEAD",
    });
    setAppType("raw");
    setStep(2); // Go to pre-filled details step
    setMode("wizard");
  };

  const handleInstall = async () => {
    if (!canInstallCatalog) {
      toast.error("You do not have permission to install catalog apps");
      return;
    }
    setInstalling(true);
    try {
      const body = appType === "helm"
        ? { appName: helmFields.appName, namespace: helmFields.namespace, yaml: generatedYaml, appType, helmRepoURL: helmFields.helmRepoURL, chartName: helmFields.chartName, chartVersion: helmFields.chartVersion }
        : { appName: rawFields.appName, namespace: rawFields.namespace, yaml: generatedYaml, appType, gitRepoURL: rawFields.gitRepoURL, gitPath: rawFields.gitPath };
      const res = await fetch("/api/catalog-install", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, commitMessage: commitMessage || defaultCommitMessage }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Install failed");
      }
      toast.success(`${appName} installed successfully! ArgoCD will sync shortly.`);
      setSuccess(true);
      onInstalled?.();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setInstalling(false);
    }
  };

  // ── Browse Mode ──────────────────────────────────────────────────────────────
  if (mode === "browse") {
    return (
      <CatalogBrowseView
        onInstall={handleCatalogInstall}
        onCustom={() => { setAppType(null); setStep(1); setMode("wizard"); }}
        installedNames={installedNames}
        canInstall={canInstallCatalog}
      />
    );
  }

  // ── Wizard Mode ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-3xl mx-auto">
      {/* Back to browse */}
      <button
        onClick={() => { setMode("browse"); setStep(1); setAppType(null); setSuccess(false); }}
        className="flex items-center gap-1.5 text-sm text-[#9e9e9e] hover:text-white mb-6 transition-colors"
      >
        <ChevronLeft className="w-4 h-4" /> Back to Catalog
      </button>

      {/* Step Indicators */}
      <div className="flex items-center gap-2 mb-8">
        {["Choose Type", "Fill Details", "Preview YAML", "Commit"].map((label, i) => {
          const stepNum = i + 1;
          const isActive = step === stepNum;
          const isDone = step > stepNum;
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-colors",
                isDone ? "bg-green-500 text-white" : isActive ? "bg-indigo-500 text-white" : "bg-white/10 text-slate-400"
              )}>
                {isDone ? <Check className="w-3.5 h-3.5" /> : stepNum}
              </div>
              <span className={cn("text-xs font-medium hidden sm:block", isActive ? "text-white" : "text-slate-500")}>
                {label}
              </span>
              {i < 3 && <ChevronRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />}
            </div>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <h3 className="text-base font-semibold text-white mb-4">Choose Application Type</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              {([
                { type: "helm" as const, icon: Package, title: "Helm Chart", desc: "Deploy from a Helm repository. Supports version pinning and values overrides." },
                { type: "raw" as const, icon: FileText, title: "Raw Manifests", desc: "Deploy Kubernetes manifests from a Git directory path." },
              ]).map(({ type, icon: Icon, title, desc }) => (
                <button key={type} onClick={() => setAppType(type)} className={cn(
                  "flex flex-col items-center gap-4 p-6 rounded-xl border transition-all text-left",
                  appType === type ? "border-indigo-500/50 bg-indigo-500/10" : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
                )}>
                  <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center", appType === type ? "bg-indigo-500/20" : "bg-white/10")}>
                    <Icon className={cn("w-6 h-6", appType === type ? "text-indigo-400" : "text-slate-400")} />
                  </div>
                  <div><h4 className="font-semibold text-white text-sm">{title}</h4><p className="text-xs text-slate-400 mt-1">{desc}</p></div>
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button onClick={() => setStep(2)} disabled={!appType}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-40">
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <h3 className="text-base font-semibold text-white mb-4">{appType === "helm" ? "Helm Chart Details" : "Raw Manifests Details"}</h3>
            <div className="space-y-4 mb-6">
              {appType === "helm" ? (
                <>
                  <Field label="App Name" required><input value={helmFields.appName} onChange={e => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); setHelmFields(p => ({ ...p, appName: v, namespace: p.namespace || v })); }} placeholder="my-app" className={inputCls} /></Field>
                  <Field label="Namespace" required><input value={helmFields.namespace} onChange={e => setHelmFields(p => ({ ...p, namespace: e.target.value }))} placeholder={helmFields.appName || "my-app"} className={inputCls} /></Field>
                  <Field label="Helm Repo URL" required><input value={helmFields.helmRepoURL} onChange={e => setHelmFields(p => ({ ...p, helmRepoURL: e.target.value }))} placeholder="https://charts.example.com" className={inputCls} /></Field>
                  <Field label="Chart Name" required><input value={helmFields.chartName} onChange={e => setHelmFields(p => ({ ...p, chartName: e.target.value }))} placeholder="my-chart" className={inputCls} /></Field>
                  <Field label="Chart Version" required><input value={helmFields.chartVersion} onChange={e => setHelmFields(p => ({ ...p, chartVersion: e.target.value }))} placeholder="1.2.3" className={inputCls} /></Field>
                  <Field label="Target Revision"><input value={helmFields.targetRevision} onChange={e => setHelmFields(p => ({ ...p, targetRevision: e.target.value }))} placeholder="HEAD" className={inputCls} /></Field>
                  <Field label="Values Override (YAML)"><textarea value={helmFields.valuesOverride} onChange={e => setHelmFields(p => ({ ...p, valuesOverride: e.target.value }))} placeholder={`replicaCount: 1\nimage:\n  tag: latest`} rows={5} className={cn(inputCls, "resize-none font-mono text-xs")} /></Field>
                </>
              ) : (
                <>
                  <Field label="App Name" required><input value={rawFields.appName} onChange={e => { const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"); setRawFields(p => ({ ...p, appName: v, namespace: p.namespace || v })); }} placeholder="my-app" className={inputCls} /></Field>
                  <Field label="Namespace" required><input value={rawFields.namespace} onChange={e => setRawFields(p => ({ ...p, namespace: e.target.value }))} placeholder={rawFields.appName || "my-app"} className={inputCls} /></Field>
                  <Field label="Git Repo URL" required><input value={rawFields.gitRepoURL} onChange={e => setRawFields(p => ({ ...p, gitRepoURL: e.target.value }))} placeholder={DEFAULT_GIT_REPO} className={inputCls} /></Field>
                  <Field label="Git Path" required><input value={rawFields.gitPath} onChange={e => setRawFields(p => ({ ...p, gitPath: e.target.value }))} placeholder="kubernetes/catalog/my-app" className={inputCls} /></Field>
                  <Field label="Target Revision"><input value={rawFields.targetRevision} onChange={e => setRawFields(p => ({ ...p, targetRevision: e.target.value }))} placeholder="HEAD" className={inputCls} /></Field>
                </>
              )}
            </div>
            <div className="flex justify-between">
              <button onClick={() => appType ? setStep(1) : setMode("browse")} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={() => setStep(3)} disabled={!canProceedStep2}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-40">
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div key="step3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <h3 className="text-base font-semibold text-white mb-2">Preview Generated YAML</h3>
            <p className="text-xs text-slate-400 mb-4">
              This ArgoCD Application manifest will be committed to{" "}
              <code className="font-mono bg-white/10 px-1 rounded">kubernetes/catalog/{appName}/application.yaml</code>
            </p>
              <div className="rounded-xl overflow-hidden border border-white/10 mb-6">
                <pre className="h-[380px] bg-[#1e1e1e] text-slate-200 font-mono text-xs leading-5 p-4 overflow-auto whitespace-pre">{generatedYaml}</pre>
              </div>
            <div className="flex justify-between">
              <button onClick={() => setStep(2)} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
              <button onClick={() => { setCommitMessage(defaultCommitMessage); setStep(4); }}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors">
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}

        {step === 4 && (
          <motion.div key="step4" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            {success ? (
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-4">
                  <Check className="w-8 h-8 text-green-400" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">{appName} installed!</h3>
                <p className="text-sm text-slate-400 mb-6">ArgoCD will sync the application shortly.</p>
                <div className="flex items-center justify-center gap-3">
                  <button onClick={() => { setSuccess(false); setStep(1); setAppType(null); setMode("browse"); }}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">
                    Back to Catalog
                  </button>
                  <button onClick={() => { setSuccess(false); setStep(1); setAppType(null); onInstalled?.(); }}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors">
                    Install Another
                  </button>
                </div>
              </div>
            ) : (
              <>
                <h3 className="text-base font-semibold text-white mb-4">Review &amp; Commit</h3>
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Files to commit</h4>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 text-sm text-slate-300">
                      <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-mono text-xs">kubernetes/catalog/{appName}/application.yaml</p>
                        <p className="text-xs text-slate-500 mt-0.5">ArgoCD Application manifest</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2 text-sm text-slate-300">
                      <FileText className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-mono text-xs">platform.yaml</p>
                        <p className="text-xs text-slate-500 mt-0.5">Adding <code className="font-mono bg-white/10 px-1 rounded">{appName}</code> to catalog.enabled</p>
                      </div>
                    </div>
                  </div>
                </div>
                <Field label="Commit Message">
                  <input value={commitMessage || defaultCommitMessage} onChange={e => setCommitMessage(e.target.value)} className={inputCls} />
                </Field>
                <div className="flex justify-between mt-6">
                  <button onClick={() => setStep(3)} className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium hover:bg-white/10 transition-colors">
                    <ChevronLeft className="w-4 h-4" /> Back
                  </button>
                  <button onClick={handleInstall} disabled={installing || !canInstallCatalog}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50 touch-manipulation min-h-[44px]">
                    {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}
                    {installing ? "Installing…" : "Install Application"}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// COMMUNITY STORE TAB  (community-apps browser)
// ══════════════════════════════════════════════════════════════════════════════

type Tier = "simple" | "medium" | "complex";

interface AppSummary {
  name: string; slug: string; image: string; icon?: string; overview?: string;
  categories: string[]; tier: Tier; stars?: number; downloads?: number;
  webUI?: string; support?: string; configCount: number;
}

interface FeedResponse {
  apps: AppSummary[]; total: number; page: number; limit: number;
  pages: number; last_updated: string; last_updated_timestamp: number;
  categories: Array<{ Cat: string; Des: string }>;
}

interface AppDetailConfig {
  name: string; target: string; type: string;
  defaultValue?: string; description?: string;
  required: boolean; masked: boolean;
}

interface RequiredVariable {
  name: string; target: string; description?: string;
  defaultValue?: string; masked: boolean; required: boolean; isPlaceholder: boolean;
}

/** Returns true if a value contains an unfilled [PLACEHOLDER] (not [PORT:xxx]) */
function isPlaceholderValue(v?: string): boolean {
  return /\[(?!PORT:\d)[^\]]+\]/i.test(v ?? "");
}

/** Extract variables that need user input from AppFeed configs */
function getRequiredVarsFromConfigs(configs: AppDetailConfig[]): RequiredVariable[] {
  return configs
    .filter(c => c.type === "Variable" && (c.required || c.masked || isPlaceholderValue(c.defaultValue)))
    .map(c => ({
      name: c.name,
      target: c.target,
      description: c.description,
      defaultValue: isPlaceholderValue(c.defaultValue) ? "" : (c.defaultValue || undefined),
      masked: c.masked,
      required: c.required,
      isPlaceholder: isPlaceholderValue(c.defaultValue),
    }));
}

interface ConversionResult {
  slug: string; tier: Tier; warnings: string[]; combinedYaml: string;
  requiredVariables?: RequiredVariable[];
}

interface DeployOptions {
  namespace: string; pvcSizeGi: number; storageClass: string;
  ingressHost: string; createIngress: boolean;
}

const TIER_CONFIG: Record<Tier, { label: string; color: string; icon: React.ReactNode; description: string }> = {
  simple: { label: "K8s Ready", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", icon: <CheckCircle className="w-3 h-3" />, description: "Standard container — deploys directly to Kubernetes" },
  medium: { label: "Custom Network", color: "text-amber-400 bg-amber-400/10 border-amber-400/30", icon: <Zap className="w-3 h-3" />, description: "Uses custom Docker networking — verify service discovery" },
  complex: { label: "Privileged", color: "text-red-400 bg-red-400/10 border-red-400/30", icon: <Shield className="w-3 h-3" />, description: "Requires privileged mode or host devices — review carefully" },
};

const COMMUNITY_CATEGORY_TABS = [
  { value: "all", label: "All" },
  { value: "monitoring", label: "Monitoring" },
  { value: "media", label: "Media" },
  { value: "games", label: "Games" },
  { value: "tools", label: "Tools" },
  { value: "security", label: "Security" },
  { value: "storage", label: "Storage" },
] as const;

const FEATURED_APP_SLUGS = ["vaultwarden", "uptime-kuma", "filebrowser", "homarr", "it-tools"];

type CommunityCategory = (typeof COMMUNITY_CATEGORY_TABS)[number]["value"];

function detectCommunityCategory(app: Pick<AppSummary, "name" | "categories" | "overview">): CommunityCategory {
  const haystack = [app.name, ...(app.categories ?? []), app.overview ?? ""].join(" ").toLowerCase();
  if (haystack.includes("grafana") || haystack.includes("prometheus") || haystack.includes("monitor") || haystack.includes("gatus")) return "monitoring";
  if (haystack.includes("plex") || haystack.includes("media") || haystack.includes("sonarr") || haystack.includes("radarr") || haystack.includes("jellyfin")) return "media";
  if (haystack.includes("game") || haystack.includes("minecraft") || haystack.includes("steam") || haystack.includes("server")) return "games";
  if (haystack.includes("security") || haystack.includes("auth") || haystack.includes("vault") || haystack.includes("firewall")) return "security";
  if (haystack.includes("storage") || haystack.includes("backup") || haystack.includes("s3") || haystack.includes("nas") || haystack.includes("disk")) return "storage";
  if (haystack.includes("tool") || haystack.includes("utility") || haystack.includes("dns") || haystack.includes("proxy") || haystack.includes("cloud") || haystack.includes("db") || haystack.includes("database")) return "tools";
  return "all";
}

function formatDownloads(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function DeployModal({ app, onClose }: { app: AppSummary; onClose: () => void }) {
  const { can } = useRBAC();
  const canReadApps = can("apps:read");
  const canDeployCommunity = can("catalog:write");
  const [step, setStep] = useState<"options" | "preview" | "deploying" | "done">("options");
  // NOTE: useTransition with async callbacks does NOT keep isPending=true for the
  // full duration of the await in React 18 — it only tracks the synchronous part.
  // Use explicit loading state instead so the spinner persists during the fetch.
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isDeployLoading, setIsDeployLoading] = useState(false);
  const isPending = isPreviewLoading || isDeployLoading;

  // App-specific required variables (fetched from detail endpoint)
  const [requiredVars, setRequiredVars] = useState<RequiredVariable[] | null>(null);
  const [userVariables, setUserVariables] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<DeployOptions>({
    namespace: app.slug, pvcSizeGi: 10, storageClass: "longhorn",
    ingressHost: `${app.slug}.${DEFAULT_INTERNAL_DOMAIN}`, createIngress: !!app.webUI,
  });
  const [preview, setPreview] = useState<ConversionResult | null>(null);
  const [deployResult, setDeployResult] = useState<{ paths: string[]; warnings: string[] } | null>(null);
  const [deployProgressStep, setDeployProgressStep] = useState(0);

  // Fetch app-specific configs to surface required/placeholder variables
  useEffect(() => {
    if (!canReadApps) return;
    fetch(`/api/community-apps/${app.slug}`)
      .then(r => r.ok ? r.json() as Promise<{ configs?: AppDetailConfig[] }> : null)
      .then(data => {
        if (!data?.configs) return;
        const vars = getRequiredVarsFromConfigs(data.configs);
        setRequiredVars(vars);
        // Pre-populate defaults for non-placeholder values
        const defaults: Record<string, string> = {};
        for (const v of vars) {
          if (v.defaultValue) defaults[v.target] = v.defaultValue;
        }
        if (Object.keys(defaults).length > 0) setUserVariables(defaults);
      })
      .catch(() => { /* non-fatal — still deployable */ });
  }, [app.slug, canReadApps]);

  const missingRequired = (requiredVars ?? []).filter(
    v => (v.required || v.isPlaceholder) && !userVariables[v.target]?.trim()
  );

  const handlePreview = async () => {
    if (!canReadApps) {
      toast.error("You do not have permission to preview community apps");
      return;
    }
    setIsPreviewLoading(true);
    try {
      const res = await fetch("/api/community-apps/convert", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: app.name, ...options, userVariables }),
      });
      const data = await res.json() as ConversionResult & { error?: string };
      if (!res.ok) { toast.error(data.error ?? "Conversion failed"); return; }
      setPreview(data);
      setStep("preview");
    } catch {
      toast.error("Failed to generate preview — AppFeed may still be loading, try again");
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleDeploy = async () => {
    if (!canDeployCommunity) {
      toast.error("You do not have permission to deploy community apps");
      return;
    }
    setIsDeployLoading(true);
    setDeployProgressStep(0);
    setStep("deploying");
    const timer = window.setTimeout(() => setDeployProgressStep(1), 900);
    try {
      const res = await fetch("/api/community-apps/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: app.name, ...options, userVariables }),
      });
      const data = await res.json() as { ok?: boolean; paths?: string[]; warnings?: string[]; error?: string; conflict?: boolean };
      if (!res.ok) {
        // 409 conflict = platform-managed app, show a clear message and go back to options
        if (res.status === 409 && data.conflict) {
          toast.error(data.error ?? "This app is already installed by the platform.", { duration: 6000 });
          setStep("options");
        } else {
          toast.error(data.error ?? "Deploy failed");
          setStep("preview");
        }
        return;
      }
      setDeployResult({ paths: data.paths ?? [], warnings: data.warnings ?? [] });
      setDeployProgressStep(2);
      setStep("done");
      toast.success(`${app.name} deployed! ArgoCD will sync in ~2 minutes. If it doesn't appear, the bootstrap file has been committed to git.`);
    } catch {
      toast.error("Deploy request failed");
      setStep("preview");
    } finally {
      window.clearTimeout(timer);
      setIsDeployLoading(false);
    }
  };


  // NOTE: no backdrop-blur — iOS Safari backdrop-filter causes sibling content to be invisible
  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget && step !== "deploying") onClose(); }}>
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
        className="bg-[#0d1117] border border-gray-200 dark:border-white/10 rounded-t-2xl sm:rounded-xl w-full sm:max-w-3xl max-h-[92dvh] sm:max-h-[90vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3">
            {app.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={app.icon} alt="" className="w-8 h-8 rounded object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <Package className="w-8 h-8 text-indigo-400" />
            )}
            <div>
              <h2 className="text-gray-900 dark:text-white font-semibold">{app.name}</h2>
              <p className="text-gray-500 dark:text-white/50 text-xs">{app.image}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 dark:text-white/40 hover:text-gray-900 dark:hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-white/10 flex-shrink-0">
          {(["options", "preview", "done"] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className="w-8 h-px bg-white/20" />}
              <div className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors",
                step === s ? "bg-indigo-500/20 text-indigo-400" :
                  (["options", "preview", "done"].indexOf(step) > i ? "text-gray-500 dark:text-white/60" : "text-gray-400 dark:text-white/30")
              )}>
                <span className="w-4 h-4 rounded-full border flex items-center justify-center text-[10px] border-current">{i + 1}</span>
                {s === "options" ? "Configure" : s === "preview" ? "Review YAML" : "Done"}
              </div>
            </div>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {isPreviewLoading && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-blue-400" />
              <p className="text-gray-600 dark:text-white/70 text-sm font-medium">Generating YAML preview…</p>
              <p className="text-gray-400 dark:text-white/40 text-xs text-center max-w-xs">First run downloads the AppFeed index (~33MB). This may take up to 30 seconds.</p>
            </div>
          )}

          {(step === "deploying" || step === "done") && (
            <div className="mb-4 rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-indigo-200/80">Install progress</p>
              <div className="space-y-2">
                {["Committing to git...", "ArgoCD syncing...", "Deployed!"].map((label, index) => {
                  const complete = deployProgressStep > index || (step === "done" && index <= 2);
                  const active = deployProgressStep === index && step !== "done";
                  return (
                    <div key={label} className="flex items-center gap-2 text-sm text-gray-600 dark:text-white/70">
                      <span className={cn(
                        "flex h-5 w-5 items-center justify-center rounded-full border text-[10px]",
                        complete ? "border-emerald-400 bg-emerald-400/20 text-emerald-300" : active ? "border-indigo-400 bg-indigo-400/20 text-indigo-200" : "border-white/15 text-gray-400 dark:text-white/40"
                      )}>
                        {complete ? <Check className="h-3 w-3" /> : index + 1}
                      </span>
                      <span className={cn(complete ? "text-emerald-300" : active ? "text-indigo-200" : "text-gray-500 dark:text-white/50")}>{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === "options" && !isPreviewLoading && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">Namespace</label>
                  <input className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.namespace} onChange={e => setOptions(o => ({ ...o, namespace: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))} />
                </div>
                <div>
                  <label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">Storage Class</label>
                  <select className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.storageClass} onChange={e => setOptions(o => ({ ...o, storageClass: e.target.value }))}>
                    <option value="longhorn">longhorn</option>
                    <option value="local-path">local-path</option>
                    <option value="longhorn-retain">longhorn-retain</option>
                  </select>
                </div>
                <div>
                  <label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">PVC Size (GiB per volume)</label>
                  <input type="number" min={1} max={10000}
                    className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.pvcSizeGi} onChange={e => setOptions(o => ({ ...o, pvcSizeGi: parseInt(e.target.value, 10) || 10 }))} />
                </div>
                <div className="flex items-start gap-3 pt-6">
                  <input type="checkbox" id="createIngress" checked={options.createIngress}
                    onChange={e => setOptions(o => ({ ...o, createIngress: e.target.checked }))} className="mt-0.5" />
                  <label htmlFor="createIngress" className="text-gray-700 dark:text-white/80 text-sm">Create Traefik IngressRoute</label>
                </div>
              </div>
              {options.createIngress && (
                <div>
                  <label className="text-gray-500 dark:text-white/60 text-xs mb-1 block">Ingress Hostname</label>
                  <input className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.ingressHost} onChange={e => setOptions(o => ({ ...o, ingressHost: e.target.value }))} />
                  <p className="text-gray-400 dark:text-white/40 text-xs mt-1">Will be VPN-only via netbird-vpn-only middleware</p>
                </div>
              )}

              {/* App-specific required / secret variables */}
              {requiredVars && requiredVars.length > 0 && (
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Settings2 className="w-4 h-4 text-amber-400" />
                    <span className="text-amber-200 text-sm font-medium">App Configuration</span>
                    {missingRequired.length > 0 && (
                      <span className="ml-auto text-xs text-red-400 bg-red-400/10 px-2 py-0.5 rounded">
                        {missingRequired.length} required
                      </span>
                    )}
                  </div>
                  <div className="space-y-3">
                    {requiredVars.map(v => (
                      <div key={v.target}>
                        <label className="flex items-center gap-1 text-gray-600 dark:text-white/70 text-xs mb-1">
                          {v.name}
                          {(v.required || v.isPlaceholder) && <span className="text-red-400">*</span>}
                          {v.masked && <span className="text-xs text-gray-400 dark:text-white/30 ml-1">(secret)</span>}
                        </label>
                        <input
                          type={v.masked ? "password" : "text"}
                          placeholder={v.isPlaceholder ? "Required — enter a value" : (v.defaultValue ?? "")}
                          value={userVariables[v.target] ?? ""}
                          onChange={e => setUserVariables(prev => ({ ...prev, [v.target]: e.target.value }))}
                          className={cn(
                            "w-full bg-gray-100 dark:bg-white/5 border rounded px-3 py-2 text-gray-900 dark:text-white text-sm focus:outline-none focus:border-indigo-500",
                            (v.required || v.isPlaceholder) && !userVariables[v.target]?.trim()
                              ? "border-red-500/50"
                              : "border-gray-200 dark:border-white/10"
                          )}
                        />
                        {v.description && (
                          <p className="text-white/35 text-xs mt-0.5 leading-relaxed">{v.description}</p>
                        )}
                      </div>
                    ))}
                  </div>
                  {missingRequired.length > 0 && (
                    <p className="text-red-400 text-xs">Fill in required fields before previewing.</p>
                  )}
                </div>
              )}

              <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 text-sm text-gray-600 dark:text-white/70 space-y-2">
                <div className="flex items-center gap-2 text-gray-900 dark:text-white">
                  <Globe className="h-4 w-4 text-indigo-300" />
                  <span className="font-medium">Connect</span>
                </div>
                {options.createIngress ? (
                  <p>
                    InfraWeaver will expose this app at <code className="rounded bg-gray-100 dark:bg-white/10 px-1.5 py-0.5 text-xs">https://{options.ingressHost}</code>
                  </p>
                ) : (
                  <p className="text-gray-500 dark:text-white/50">Ingress is disabled. You can enable it now or connect later from the generated manifests.</p>
                )}
                {app.webUI && (
                  <p className="text-gray-500 dark:text-white/50">
                    Original app WebUI hint: <code className="rounded bg-gray-100 dark:bg-white/10 px-1.5 py-0.5 text-xs">{app.webUI}</code>
                  </p>
                )}
              </div>
              {app.tier !== "simple" && (
                <div className={cn("flex gap-2 p-3 rounded-lg border text-sm", TIER_CONFIG[app.tier].color)}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <p>{TIER_CONFIG[app.tier].description}</p>
                </div>
              )}
            </div>
          )}

          {(step === "preview" || step === "deploying") && preview && (
            <div className="space-y-3">
              {preview.warnings.length > 0 && (
                <div className="space-y-2">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className={cn("flex gap-2 p-2.5 rounded-lg border text-xs",
                      w.startsWith("⚠️") ? "text-amber-400 bg-amber-400/10 border-amber-400/20" : "text-blue-400 bg-blue-400/10 border-blue-400/20")}>
                      <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /><span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="h-[380px] rounded-lg overflow-hidden border border-gray-200 dark:border-white/10 relative">
                {isPreviewLoading && <div className="absolute inset-0 flex items-center justify-center bg-gray-50 dark:bg-[#1e1e1e] z-10"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>}
                <pre className="w-full h-full bg-gray-50 dark:bg-[#1e1e1e] text-slate-800 dark:text-slate-200 font-mono text-xs leading-5 p-4 overflow-auto whitespace-pre">{preview.combinedYaml}</pre>
              </div>
              <p className="text-gray-400 dark:text-white/40 text-xs">This YAML will be committed to <code className="bg-gray-100 dark:bg-white/10 px-1 rounded">kubernetes/catalog/{preview.slug}/manifests/</code> and deployed by ArgoCD.</p>
            </div>
          )}

          {step === "done" && deployResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-emerald-400">
                <CheckCircle className="w-8 h-8" />
                <div>
                  <p className="font-semibold">App deployed! Bootstrap file committed to Git</p>
                  <p className="text-gray-500 dark:text-white/50 text-sm">ArgoCD usually shows {app.name} within ~2 minutes.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                <Info className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-indigo-200 space-y-1">
                  <p>✓ ArgoCD sync is not instant — give it about 2 minutes to appear.</p>
                  <p>If it does not show up yet, the bootstrap file was still committed to git. Check the <button onClick={onClose} className="text-indigo-300 underline hover:text-indigo-100">All Installed</button> tab again shortly.</p>
                </div>
              </div>
              <div className="bg-gray-100 dark:bg-white/5 rounded-lg p-3 space-y-1">
                <p className="text-gray-500 dark:text-white/60 text-xs font-medium mb-2">Files committed:</p>
                {deployResult.paths.map(p => (
                  <div key={p} className="flex items-center gap-2 text-xs text-gray-600 dark:text-white/70">
                    <GitBranch className="w-3 h-3 text-indigo-400" /><code>{p}</code>
                  </div>
                ))}
              </div>
              {deployResult.warnings.length > 0 && (
                <div className="space-y-1">{deployResult.warnings.map((w, i) => <p key={i} className="text-amber-400 text-xs">{w}</p>)}</div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between p-5 border-t border-gray-200 dark:border-white/10 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-gray-500 dark:text-white/60 hover:text-gray-900 dark:hover:text-white text-sm transition-colors">{step === "done" ? "Close" : "Cancel"}</button>
          <div className="flex gap-3">
            {step === "preview" && (
              <button onClick={() => setStep("options")} className="flex items-center gap-2 px-4 py-2 rounded-lg text-gray-600 dark:text-white/70 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 transition-colors text-sm">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === "options" && (
              <button onClick={handlePreview} disabled={isPending || !canReadApps || missingRequired.length > 0}
                title={missingRequired.length > 0 ? "Fill in required fields above first" : undefined}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Preview YAML
              </button>
            )}
            {step === "preview" && (
              <button onClick={handleDeploy} disabled={isPending || !canDeployCommunity}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Terminal className="w-4 h-4" />} Deploy to Cluster
              </button>
            )}
            {step === "done" && (
              <button onClick={onClose}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors">
                View Installed →
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function AppCard({ app, onDeploy, canDeploy, installed }: { app: AppSummary; onDeploy: (app: AppSummary) => void; canDeploy: boolean; installed: boolean }) {
  const tierCfg = TIER_CONFIG[app.tier];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="group relative bg-gray-100 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 transition-all duration-200 flex flex-col gap-3">
      {installed && (
        <span className="absolute right-3 top-3 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          Installed
        </span>
      )}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {app.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.icon} alt="" className="w-8 h-8 object-contain" onError={e => {
              const el = e.target as HTMLImageElement;
              el.style.display = "none";
              el.parentElement!.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
            }} />
          ) : <Package className="w-5 h-5 text-gray-400 dark:text-white/30" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-gray-900 dark:text-white font-medium text-sm truncate">{app.name}</p>
          <p className="text-gray-400 dark:text-white/40 text-xs truncate">{app.image}</p>
        </div>
        <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0", tierCfg.color)}>
          {tierCfg.icon} {tierCfg.label}
        </span>
      </div>
      {app.overview && <p className="text-gray-500 dark:text-white/50 text-xs leading-relaxed line-clamp-2">{app.overview}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        {(app.stars ?? 0) > 0 && <span className="flex items-center gap-1 text-gray-400 dark:text-white/40 text-[10px]"><Star className="w-3 h-3" /> {app.stars?.toLocaleString()}</span>}
        {(app.downloads ?? 0) > 0 && <span className="flex items-center gap-1 text-gray-400 dark:text-white/40 text-[10px]"><Download className="w-3 h-3" /> {formatDownloads(app.downloads)}</span>}
        {app.categories.slice(0, 2).map(cat => (
          <span key={cat} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-white/40 text-[10px]">{cat.replace(/:/g, " › ")}</span>
        ))}
      </div>
      <div className="flex gap-2 mt-auto pt-1">
        {app.support && (
          <a href={app.support} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 transition-colors">
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
        )}
        <button onClick={() => onDeploy(app)} disabled={!canDeploy}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded text-xs font-medium bg-indigo-600/80 hover:bg-indigo-500 text-gray-900 dark:text-white transition-colors disabled:opacity-50 touch-manipulation min-h-[44px]">
          <Globe className="w-3 h-3" /> {installed ? "Reconfigure" : "Deploy"}
        </button>
      </div>
    </motion.div>
  );
}

function CommunityStoreTab() {
  const { can } = useRBAC();
  const canDeployCommunity = can("catalog:write");
  const { data: argoApps } = useArgoApps();
  const [storeTab, setStoreTab] = useState<"store" | "installed">("store");
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<CommunityCategory>("all");
  const [tier, setTier] = useState("");
  const [deployApp, setDeployApp] = useState<AppSummary | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [installed, setInstalled] = useState<InstalledCommunityAppsResponse | null>(null);
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError] = useState<string | null>(null);

  const fetchApps = useCallback(async (opts: { page: number; search: string; category: string; tier: string }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(opts.page), limit: "24",
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.tier ? { tier: opts.tier } : {}),
      });
      const res = await fetch(`/api/community-apps?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as FeedResponse);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInstalled = useCallback(async () => {
    setInstalledLoading(true);
    setInstalledError(null);
    try {
      const res = await fetch("/api/community-apps/installed");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInstalled(await res.json() as InstalledCommunityAppsResponse);
    } catch (err) {
      setInstalledError(String(err));
    } finally {
      setInstalledLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchApps({ page: 1, search: "", category: "all", tier: "" });
  }, [fetchApps]);
  useEffect(() => {
    if (storeTab === "installed" && !installed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchInstalled();
    }
  }, [storeTab, installed, fetchInstalled]);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => { setDebouncedSearch(value); setPage(1); void fetchApps({ page: 1, search: value, category, tier }); }, 300);
  };

  const handleCategory = (cat: CommunityCategory) => { setCategory(cat); setPage(1); void fetchApps({ page: 1, search: debouncedSearch, category: cat, tier }); };
  const handleTier = (t: string) => { setTier(t); setPage(1); void fetchApps({ page: 1, search: debouncedSearch, category, tier: t }); };
  const handlePage = (p: number) => { setPage(p); void fetchApps({ page: p, search: debouncedSearch, category, tier }); };

  const installedSlugs = useMemo(() => {
    const fromArgo = new Set(
      (argoApps ?? [])
        .map((app) => app.metadata?.name ?? "")
        .map((name) => name.match(/^catalog-(.+)-manifests$/)?.[1] ?? "")
        .filter(Boolean)
    );
    for (const app of installed?.apps ?? []) {
      fromArgo.add(app.slug);
    }
    return fromArgo;
  }, [argoApps, installed]);

  const storeApps = (data?.apps ?? []).filter((app) => category === "all" || detectCommunityCategory(app) === category);
  const featuredApps = useMemo(() => {
    const appMap = new Map((data?.apps ?? []).map((app) => [app.slug, app]));
    return FEATURED_APP_SLUGS
      .map((slug) => appMap.get(slug))
      .filter((app): app is AppSummary => Boolean(app));
  }, [data?.apps]);

  return (
    <div className="space-y-5">
      {/* Sub-header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-gray-500 dark:text-white/50 text-sm">Browse 3,500+ apps from the Unraid Community Applications feed — convert and deploy to Kubernetes</p>
          {storeTab === "store" && data?.last_updated && (
            <p className="text-gray-400 dark:text-white/30 text-xs mt-0.5">Feed updated: {data.last_updated} · {data.total.toLocaleString()} apps</p>
          )}
          {storeTab === "installed" && installed && (
            <p className="text-gray-400 dark:text-white/30 text-xs mt-0.5">{installed.total} app{installed.total !== 1 ? "s" : ""} installed</p>
          )}
        </div>
        <button onClick={storeTab === "store" ? () => void fetchApps({ page, search: debouncedSearch, category, tier }) : () => { setInstalled(null); void fetchInstalled(); }}
          className="flex min-h-[40px] flex-shrink-0 items-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 px-3 py-2 text-sm text-gray-500 dark:text-white/60 transition-colors hover:border-white/30 hover:text-gray-900 dark:hover:text-white">
          <RefreshCw className={cn("w-4 h-4", (loading || installedLoading) && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* Store / Installed sub-tabs */}
      <div className="flex w-full gap-1 overflow-x-auto rounded-lg bg-gray-100 dark:bg-white/5 p-1 sm:w-fit">
        <button onClick={() => setStoreTab("store")}
          className={cn("flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-all", storeTab === "store" ? "bg-indigo-600 text-white" : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white")}>
          <Store className="w-4 h-4" /> Store
        </button>
        <button onClick={() => setStoreTab("installed")}
          className={cn("flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-all", storeTab === "installed" ? "bg-indigo-600 text-white" : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white")}>
          <Package className="w-4 h-4" /> Installed
          {installed && installed.total > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-white/10 text-xs">{installed.total}</span>}
        </button>
      </div>

      {storeTab === "store" && (
        <>
          {featuredApps.length > 0 && (
            <div className="space-y-3 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">✨ Recommended Starter Apps — ready to deploy</p>
                  <p className="text-xs text-gray-500 dark:text-white/50">Simple, lightweight community apps that work well with the default setup.</p>
                </div>
                <span className="hidden rounded-full border border-indigo-400/30 bg-indigo-400/10 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-indigo-200 sm:inline-flex">Featured</span>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none">
                {featuredApps.map((app) => (
                  <div key={`featured-${app.slug}`} className="min-w-[260px] max-w-[260px] flex-shrink-0 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5">
                        {app.icon ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={app.icon} alt="" className="h-8 w-8 object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <Package className="h-5 w-5 text-gray-400 dark:text-white/30" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{app.name}</p>
                          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Featured</span>
                        </div>
                        <p className="truncate text-xs text-gray-400 dark:text-white/40">{app.image}</p>
                      </div>
                    </div>
                    <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-white/55">{app.overview ?? "Reliable starter app for a fresh community apps setup."}</p>
                    <div className="mt-3 flex items-center gap-2 text-[10px] text-white/35">
                      <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-emerald-300">Simple tier</span>
                      <span>HTTP friendly</span>
                    </div>
                    <button
                      onClick={() => setDeployApp(app)}
                      disabled={!canDeployCommunity}
                      className="mt-4 flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600/80 px-3 py-2 text-xs font-medium text-gray-900 dark:text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 touch-manipulation"
                    >
                      <Globe className="h-3 w-3" /> {installedSlugs.has(app.slug) ? "Reconfigure" : "Quick deploy"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {(Object.entries(TIER_CONFIG) as Array<[Tier, typeof TIER_CONFIG.simple]>).map(([key, cfg]) => (
              <button key={key} onClick={() => handleTier(tier === key ? "" : key)}
                className={cn("flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
                  tier === key ? cfg.color : "text-gray-400 dark:text-white/40 bg-gray-100 dark:bg-white/5 border-gray-200 dark:border-white/10 hover:border-white/30")}>
                {cfg.icon} {cfg.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-white/40" />
              <input type="text" placeholder="Search apps, images, descriptions…" value={search} onChange={e => handleSearch(e.target.value)}
                className="w-full bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 focus:border-indigo-500/50 rounded-lg pl-10 pr-4 py-2.5 text-gray-900 dark:text-white text-sm placeholder-white/30 focus:outline-none transition-colors" />
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {COMMUNITY_CATEGORY_TABS.map((cat) => (
              <button key={cat.value} onClick={() => handleCategory(cat.value)}
                className={cn("flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-all border",
                  category === cat.value ? "bg-indigo-600 text-white border-indigo-500" : "text-gray-500 dark:text-white/50 border-gray-200 dark:border-white/10 hover:border-white/30 hover:text-white/80")}>
                {cat.label}
              </button>
            ))}
          </div>
          {error && <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm"><AlertTriangle className="w-4 h-4" /> {error}</div>}
          {loading && !data && <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-indigo-400 animate-spin" /></div>}
          {data && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-400 dark:text-white/40">
                <span>{storeApps.length.toLocaleString()} apps{debouncedSearch ? ` matching "${debouncedSearch}"` : ""}</span>
                <span>Page {data.page} of {data.pages}</span>
              </div>
              {loading && <div className="flex justify-center"><Loader2 className="w-6 h-6 text-indigo-400 animate-spin" /></div>}
              <div className={cn("grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity", loading && "opacity-50")}>
                {storeApps.map((app) => (
                  <AppCard
                    key={app.slug + app.image}
                    app={app}
                    onDeploy={setDeployApp}
                    canDeploy={canDeployCommunity}
                    installed={installedSlugs.has(app.slug)}
                  />
                ))}
              </div>
              {storeApps.length === 0 && !loading && (
                <div className="text-center py-16 text-gray-400 dark:text-white/40">
                  <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No apps found. Try adjusting your search or filters.</p>
                </div>
              )}
              {data.pages > 1 && (
                <div className="flex items-center justify-center gap-1.5 pt-4">
                  <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-gray-500 dark:text-white/60 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm">
                    <ChevronLeft className="w-4 h-4" /><span className="hidden sm:inline">Prev</span>
                  </button>
                  <span className="sm:hidden px-3 py-2 text-gray-500 dark:text-white/50 text-sm">{page} / {data.pages}</span>
                  <div className="hidden sm:flex items-center gap-1.5">
                    {Array.from({ length: Math.min(7, data.pages) }, (_, i) => {
                      const p = page <= 4 ? i + 1 : page >= data.pages - 3 ? data.pages - 6 + i : page - 3 + i;
                      if (p < 1 || p > data.pages) return null;
                      return (
                        <button key={p} onClick={() => handlePage(p)}
                          className={cn("w-9 h-9 rounded-lg text-sm transition-colors", p === page ? "bg-indigo-600 text-white" : "text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30")}>
                          {p}
                        </button>
                      );
                    })}
                  </div>
                  <button onClick={() => handlePage(page + 1)} disabled={page === data.pages}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-gray-500 dark:text-white/60 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm">
                    <span className="hidden sm:inline">Next</span><ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {storeTab === "installed" && (
        <>
          {installed?.reason === "github_token_missing" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div>GitHub token not configured — set GITHUB_TOKEN in cluster secrets to track installed community apps.</div>
            </div>
          )}
          {installedError && <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm"><AlertTriangle className="w-4 h-4" /> {installedError}</div>}
          {installedLoading && !installed && <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-indigo-400 animate-spin" /></div>}
          {installed && installed.total === 0 && (
            <div className="text-center py-20 text-gray-400 dark:text-white/40">
              <Package className="w-14 h-14 mx-auto mb-4 opacity-20" />
              <p className="text-lg font-medium">No apps installed yet</p>
              <p className="text-sm mt-1">Browse the <button onClick={() => setStoreTab("store")} className="text-indigo-400 hover:underline">Store</button> and deploy your first app</p>
            </div>
          )}
          {installed && installed.total > 0 && (
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {installed.apps.map(app => {
                const tierCfg = TIER_CONFIG[app.tier as Tier] ?? TIER_CONFIG.simple;
                return (
                  <div key={app.slug} className="group bg-gray-100 dark:bg-white/[0.03] hover:bg-gray-100 dark:hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 flex flex-col gap-3 transition-all duration-200">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 flex items-center justify-center flex-shrink-0">
                        <Package className="w-5 h-5 text-indigo-400/70" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-900 dark:text-white font-medium text-sm truncate">{app.name}</p>
                        <p className="text-gray-400 dark:text-white/40 text-xs truncate">{app.namespace}</p>
                      </div>
                      <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0", tierCfg.color)}>
                        {tierCfg.icon} {tierCfg.label}
                      </span>
                    </div>
                    {app.description && <p className="text-gray-500 dark:text-white/50 text-xs leading-relaxed line-clamp-2">{app.description}</p>}
                    {app.image && <p className="text-gray-400 dark:text-white/30 text-[10px] truncate font-mono">{app.image}</p>}
                    <div className="flex items-center gap-2 flex-wrap">
                      {app.categories.slice(0, 2).map(cat => (
                        <span key={cat} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-white/5 text-gray-400 dark:text-white/40 text-[10px]">{cat.replace(/:/g, " › ")}</span>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-auto pt-1">
                      {app.ingressHost && (
                        <a href={`https://${app.ingressHost}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 transition-colors">
                          <ExternalLink className="w-3 h-3" /> Open
                        </a>
                      )}
                      <a href={`${DEFAULT_GIT_REPO}/tree/main/${app.manifestsPath}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-gray-500 dark:text-white/50 hover:text-gray-900 dark:hover:text-white border border-gray-200 dark:border-white/10 hover:border-white/30 transition-colors">
                        <GitBranch className="w-3 h-3" /> Manifests
                      </a>
                      {app.installedAt && <span className="ml-auto text-white/25 text-[10px] self-center">{new Date(app.installedAt).toLocaleDateString()}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Deploy modal — portaled to document.body to escape layout z-10 stacking context */}
      <BodyPortal>
        <AnimatePresence>
          {deployApp && <DeployModal app={deployApp} onClose={() => setDeployApp(null)} />}
        </AnimatePresence>
      </BodyPortal>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ══════════════════════════════════════════════════════════════════════════════

const TOP_TABS: Array<{ value: TopTab; label: string; icon: React.ElementType }> = [
  { value: "installed", label: "All Installed", icon: Layers },
  { value: "catalog", label: "Platform Catalog", icon: Package },
  { value: "community", label: "Community", icon: Store },
];

export default function AppsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [installSource, setInstallSource] = useState<"catalog" | "community" | null>(null);

  // Listen for FAB "Install App" button on mobile
  useEffect(() => {
    const handler = () => { setInstallSource(null); setShowInstallModal(true); };
    window.addEventListener("fab:apps:install", handler);
    return () => window.removeEventListener("fab:apps:install", handler);
  }, []);

  const rawTab = searchParams?.get("tab");
  const activeTab: TopTab =
    rawTab === "catalog" ? "catalog" : rawTab === "community" ? "community" : "installed";

  const setActiveTab = (tab: TopTab) => {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (tab === "installed") { params.delete("tab"); } else { params.set("tab", tab); }
    router.push(`/apps${params.size > 0 ? `?${params}` : ""}`);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Apps"
        icon={LayoutGrid}
        subtitle="Install and manage all platform applications"
        actions={
          <button
            onClick={() => { setInstallSource(null); setShowInstallModal(true); }}
            className="flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 sm:w-auto touch-manipulation"
          >
            <PlusCircle className="w-4 h-4" />
            <span>Install App</span>
          </button>
        }
      />

      {/* Top tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 dark:border-[#2a2a2a] scrollbar-none touch-pan-x">
        {TOP_TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                "flex min-h-[40px] flex-shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors -mb-px",
                activeTab === tab.value
                  ? "border-[#0078D4] text-[#0078D4]"
                  : "border-transparent text-gray-500 dark:text-[#9e9e9e] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
              )}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.label.split(" ").slice(-1)[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "installed" && <AllInstalledTab />}
          {activeTab === "catalog" && <CatalogInstallerTab onInstalled={() => setActiveTab("installed")} />}
          {activeTab === "community" && <CommunityStoreTab />}
        </motion.div>
      </AnimatePresence>

      {/* + Install App modal: choose source */}
      <BodyPortal>
        <AnimatePresence>
          {showInstallModal && !installSource && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/75 p-4"
              onClick={() => setShowInstallModal(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 16 }}
                transition={{ duration: 0.15 }}
                className="bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#333] rounded-2xl p-6 w-full max-w-sm shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-base font-semibold text-gray-900 dark:text-white">Choose Install Source</h2>
                  <button onClick={() => setShowInstallModal(false)} className="text-gray-400 dark:text-[#666] hover:text-gray-900 dark:hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setShowInstallModal(false); setActiveTab("catalog"); }}
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border border-gray-200 dark:border-[#333] hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all group"
                  >
                    <Package className="w-8 h-8 text-gray-500 dark:text-[#9e9e9e] group-hover:text-indigo-400 transition-colors" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">Platform Catalog</p>
                      <p className="text-xs text-gray-400 dark:text-[#666] mt-0.5">Helm &amp; Git apps</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { setShowInstallModal(false); setActiveTab("community"); }}
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border border-gray-200 dark:border-[#333] hover:border-purple-500/50 hover:bg-purple-500/10 transition-all group"
                  >
                    <Store className="w-8 h-8 text-gray-500 dark:text-[#9e9e9e] group-hover:text-purple-400 transition-colors" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-gray-900 dark:text-white">Community Store</p>
                      <p className="text-xs text-gray-400 dark:text-[#666] mt-0.5">3,500+ UnrAid apps</p>
                    </div>
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </BodyPortal>
    </div>
  );
}
