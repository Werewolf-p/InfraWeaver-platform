"use client";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import {
  Package, FileText, ChevronRight, ChevronLeft, Check, Loader2,
  PlusCircle, Search, ExternalLink, AlertTriangle, Info, CheckCircle,
  Globe, Star, X, Shield, Zap, GitBranch, Eye, Store,
  Terminal, Download, RefreshCw, LayoutGrid, Layers, Settings2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { useArgoApps } from "@/hooks/use-argocd";
import { StatusBadge } from "@/components/ui/status-badge";
import { UpdatePolicyModal } from "@/components/apps/update-policy-modal";



// ── BodyPortal ────────────────────────────────────────────────────────────────
function BodyPortal({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

import { useSimpleMode } from "@/contexts/simple-mode-context";
import { AppCardSkeleton, TableRowSkeleton } from "@/components/ui/skeleton-card";

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
  sourceType: "Helm" | "Git" | "Community";
}

function SwipeableAppCard({
  row,
  syncingApp,
  deletingApp,
  onSync,
  onDelete,
  isOptimisticSyncing,
}: {
  row: AppRow;
  syncingApp: string | null;
  deletingApp: string | null;
  onSync: (name: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  isOptimisticSyncing?: boolean;
}) {
  const x = useMotionValue(0);
  const isCatalog = row.source === "Catalog";

  const syncOpacity = useTransform(x, [0, 80], [0, 1]);
  const deleteOpacity = useTransform(x, [-80, 0], [1, 0]);

  const handleDragEnd = (_: unknown, info: { offset: { x: number } }) => {
    if (!isCatalog) return;
    if (info.offset.x > 80) {
      void onSync(row.name);
    } else if (info.offset.x < -80) {
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
        drag={isCatalog ? "x" : false}
        dragConstraints={{ left: -100, right: 100 }}
        dragElastic={0.1}
        onDragEnd={handleDragEnd}
        whileTap={{ cursor: "grabbing" }}
        className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 relative z-10 touch-manipulation"
      >
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0 mr-3">
            <Link href={`/apps/${encodeURIComponent(row.name)}`} className="block truncate text-sm font-medium text-[#f2f2f2] transition hover:text-[#7cb9ff]">{row.name}</Link>
            <p className="text-xs text-[#9e9e9e] font-mono truncate mt-0.5">{row.namespace}</p>
          </div>
          <StatusBadge status={isOptimisticSyncing ? "syncing" : row.health} />
        </div>
        <div className="flex items-center gap-2 mb-3">
          <StatusBadge status={row.syncStatus} />
          <span className={cn(
            "px-2 py-0.5 rounded text-xs font-medium",
            row.source === "Catalog"
              ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
              : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
          )}>
            {row.source}
          </span>
        </div>
        {isCatalog && (
          <div className="flex gap-2">
            <button
              onClick={() => void onSync(row.name)}
              disabled={syncingApp === row.name}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs border border-[#333] text-[#9e9e9e] hover:text-white hover:border-[#555] transition-colors min-h-[44px] disabled:opacity-50"
            >
              {syncingApp === row.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Sync
            </button>
            <button
              onClick={() => void onDelete(row.name)}
              disabled={deletingApp === row.name}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors min-h-[44px] disabled:opacity-50"
            >
              {deletingApp === row.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
              Delete
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}

function AllInstalledTab() {
  const { data: argoApps, isLoading: argoLoading, refetch } = useArgoApps();
  const [communityApps, setCommunityApps] = useState<InstalledCommunityApp[]>([]);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [syncingApp, setSyncingApp] = useState<string | null>(null);
  const [deletingApp, setDeletingApp] = useState<string | null>(null);
  const [uninstallingApp, setUninstallingApp] = useState<string | null>(null);
  const [optimisticSyncing, setOptimisticSyncing] = useState<Set<string>>(new Set());
  const [updatePolicyApp, setUpdatePolicyApp] = useState<{ name: string; slug: string } | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCommunityLoading(true);
    fetch("/api/community-apps/installed")
      .then(r => r.ok ? r.json() : { apps: [] })
      .then((d: { apps?: InstalledCommunityApp[] }) => setCommunityApps(d.apps ?? []))
      .catch(() => setCommunityApps([]))
      .finally(() => setCommunityLoading(false));
  }, []);

  const allRows = useMemo(() => {
    const argo = (argoApps ?? []).map(app => ({
      id: app.metadata?.name ?? "",
      name: app.metadata?.name ?? "",
      namespace: app.spec?.destination?.namespace ?? "",
      health: toHealthStatus(app.status?.health?.status ?? "Unknown"),
      syncStatus: toHealthStatus(app.status?.sync?.status ?? "Unknown"),
      source: "Catalog" as const,
      lastSync: app.status?.reconciledAt ?? "",
      sourceType: (app.spec?.source?.repoURL?.includes("charts") ? "Helm" : "Git") as "Helm" | "Git",
    }));

    const community = communityApps.map(app => ({
      id: `community-${app.slug}`,
      name: app.slug,
      namespace: app.namespace,
      health: "progressing" as AppHealthStatus,
      syncStatus: "progressing" as AppHealthStatus,
      source: "Community" as const,
      lastSync: app.installedAt,
      sourceType: "Community" as const,
    }));

    return [...argo, ...community];
  }, [argoApps, communityApps]);

  const filtered = useMemo(() => {
    if (!search.trim()) return allRows;
    const q = search.toLowerCase();
    return allRows.filter(r => r.name.toLowerCase().includes(q) || r.namespace.toLowerCase().includes(q));
  }, [allRows, search]);

  const handleSync = async (name: string) => {
    setSyncingApp(name);
    setOptimisticSyncing(prev => new Set([...prev, name]));
    try {
      const res = await fetch(`/api/argocd/apps/${encodeURIComponent(name)}/sync`, { method: "POST" });
      if (!res.ok) throw new Error("Sync failed");
      toast.success(`Syncing ${name}…`);
      setTimeout(() => void refetch(), 2000);
    } catch {
      toast.error(`Failed to sync ${name}`);
    } finally {
      setSyncingApp(null);
      setOptimisticSyncing(prev => { const next = new Set(prev); next.delete(name); return next; });
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete application "${name}"? This cannot be undone.`)) return;
    setDeletingApp(name);
    try {
      const res = await fetch(`/api/argocd/apps/${encodeURIComponent(name)}/delete`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast.success(`Deleted ${name}`);
      void refetch();
    } catch {
      toast.error(`Failed to delete ${name}`);
    } finally {
      setDeletingApp(null);
    }
  };

  const handleUninstallCommunity = async (slug: string) => {
    if (!confirm(`Uninstall "${slug}"?\n\nThis removes the app from git. ArgoCD will clean up deployed resources within a few minutes.`)) return;
    setUninstallingApp(slug);
    try {
      const res = await fetch(`/api/community-apps/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const data = (await res.json()) as { message?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Uninstall failed");
      toast.success(data.message ?? `${slug} scheduled for removal`);
      setCommunityApps(prev => prev.filter(a => a.slug !== slug));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setUninstallingApp(null);
    }
  };

  const loading = argoLoading || communityLoading;
  const { simpleMode, toggle } = useSimpleMode();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search apps…"
            className="w-full bg-[#0f0f0f] border border-[#333] rounded-lg pl-9 pr-3 py-2 text-sm text-[#f2f2f2] placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50"
          />
        </div>
        <button
          onClick={toggle}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors",
            simpleMode
              ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-400"
              : "border-[#333] text-[#666] hover:text-[#9e9e9e]"
          )}
        >
          {simpleMode ? "Simple" : "Advanced"}
        </button>
        <button
          onClick={() => void refetch()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[#333] text-[#9e9e9e] hover:text-white hover:border-[#555] transition-colors text-sm"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
        <span className="text-sm text-[#666]">{allRows.length} apps</span>
      </div>

      {loading && filtered.length === 0 && (
        <>
          {/* Desktop skeleton */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#2a2a2a] text-[#666] text-xs">
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  {!simpleMode && <th className="text-left py-2 px-3 font-medium">Namespace</th>}
                  <th className="text-left py-2 px-3 font-medium">Health</th>
                  <th className="text-left py-2 px-3 font-medium">Sync</th>
                  <th className="text-left py-2 px-3 font-medium">Source</th>
                  {!simpleMode && <th className="text-left py-2 px-3 font-medium">Last Sync</th>}
                  <th className="text-right py-2 px-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {[...Array(5)].map((_, i) => <TableRowSkeleton key={i} />)}
              </tbody>
            </table>
          </div>
          {/* Mobile skeleton */}
          <div className="md:hidden space-y-3">
            {[...Array(4)].map((_, i) => <AppCardSkeleton key={i} />)}
          </div>
        </>
      )}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 text-[#555]">
          <Layers className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No applications found</p>
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        {filtered.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#2a2a2a] text-[#666] text-xs">
                <th className="text-left py-2 px-3 font-medium">Name</th>
                {!simpleMode && <th className="text-left py-2 px-3 font-medium">Namespace</th>}
                <th className="text-left py-2 px-3 font-medium">Health</th>
                <th className="text-left py-2 px-3 font-medium">Sync</th>
                <th className="text-left py-2 px-3 font-medium">Source</th>
                {!simpleMode && <th className="text-left py-2 px-3 font-medium">Last Sync</th>}
                <th className="text-right py-2 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => (
                <tr key={row.id} className="border-b border-[#1e1e1e] hover:bg-[#1a1a1a] transition-colors">
                  <td className="py-2.5 px-3 font-medium text-[#f2f2f2]">
                    <Link href={`/apps/${encodeURIComponent(row.name)}`} className="transition hover:text-[#7cb9ff]">
                      {row.name}
                    </Link>
                  </td>
                  {!simpleMode && <td className="py-2.5 px-3 font-mono text-xs text-[#9e9e9e]">{row.namespace}</td>}
                  <td className="py-2.5 px-3"><StatusBadge status={optimisticSyncing.has(row.name) ? "syncing" : row.health} /></td>
                  <td className="py-2.5 px-3"><StatusBadge status={row.syncStatus} /></td>
                  <td className="py-2.5 px-3">
                    <span className={cn(
                      "px-2 py-0.5 rounded text-xs font-medium",
                      row.source === "Catalog"
                        ? "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                        : "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                    )}>
                      {row.source}
                    </span>
                  </td>
                  {!simpleMode && <td className="py-2.5 px-3 text-xs text-[#666]">{row.lastSync ? new Date(row.lastSync).toLocaleString() : "—"}</td>}
                  <td className="py-2.5 px-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {row.source === "Catalog" && (
                        <>
                          <PolicyBadge slug={row.name} />
                          <button
                            onClick={() => setUpdatePolicyApp({ name: row.name, slug: row.name })}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#2a2a2a] text-[#666] hover:text-[#0078D4] hover:border-[#0078D4]/40 transition-colors"
                            title="Update Policy"
                          >
                            <Settings2 className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => void handleSync(row.name)}
                            disabled={syncingApp === row.name}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-[#333] text-[#9e9e9e] hover:text-white hover:border-[#555] transition-colors disabled:opacity-50"
                          >
                            {syncingApp === row.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Sync
                          </button>
                          <button
                            onClick={() => void handleDelete(row.name)}
                            disabled={deletingApp === row.name}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                          >
                            {deletingApp === row.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                            Delete
                          </button>
                        </>
                      )}
                      {row.source === "Community" && (
                        <button
                          onClick={() => void handleUninstallCommunity(row.name)}
                          disabled={uninstallingApp === row.name}
                          className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                        >
                          {uninstallingApp === row.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                          Uninstall
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        <AnimatePresence>
          {filtered.map((row, index) => (
            <motion.div
              key={row.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.05, 0.25), duration: 0.2 }}
            >
              <SwipeableAppCard
                row={row}
                syncingApp={syncingApp}
                deletingApp={deletingApp}
                onSync={handleSync}
                onDelete={handleDelete}
                isOptimisticSyncing={optimisticSyncing.has(row.name)}
              />
              {row.source === "Catalog" && (
                <div className="flex items-center gap-2 mt-2 px-1">
                  <PolicyBadge slug={row.name} />
                  <button
                    onClick={() => setUpdatePolicyApp({ name: row.name, slug: row.name })}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-[#2a2a2a] text-[#666] hover:text-[#0078D4] hover:border-[#0078D4]/40 transition-colors min-h-[36px]"
                  >
                    <Settings2 className="w-3.5 h-3.5" /> Update Policy
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Update Policy Modal */}
      {updatePolicyApp && (
        <UpdatePolicyModal
          appName={updatePolicyApp.name}
          appSlug={updatePolicyApp.slug}
          open={true}
          onClose={() => setUpdatePolicyApp(null)}
        />
      )}
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

const DEFAULT_GIT_REPO = "https://github.com/Werewolf-p/InfraWeaver-platform";
const inputCls = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors";

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">
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
}: {
  app: CatalogAppEntry;
  installed: boolean;
  onInstall: (app: CatalogAppEntry) => void;
}) {
  const displayName = app.name.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 flex flex-col gap-3 transition-all duration-200"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-[#0078D4]/20 border border-[#0078D4]/30 flex items-center justify-center flex-shrink-0">
          <Package className="w-4 h-4 text-[#0078D4]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{displayName}</p>
          <p className="text-white/40 text-[10px] font-mono truncate">{app.name}</p>
        </div>
        {installed && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium text-emerald-400 flex-shrink-0">
            <Check className="w-2.5 h-2.5" /> Installed
          </span>
        )}
      </div>

      {/* Description */}
      {app.description && (
        <p className="text-white/50 text-xs leading-relaxed line-clamp-2 flex-1">{app.description}</p>
      )}

      {/* Host */}
      {app.host && (
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-white/10">
          <Globe className="w-3 h-3 text-white/40 flex-shrink-0" />
          <span className="text-white/50 text-[10px] font-mono truncate">{app.host}</span>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1">
        <button
          onClick={() => onInstall(app)}
          disabled={installed}
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors min-h-[36px]",
            installed
              ? "bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 cursor-default"
              : "bg-[#0078D4] hover:bg-[#0066b8] text-white"
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
}: {
  onInstall: (app: CatalogAppEntry) => void;
  onCustom: () => void;
  installedNames: Set<string>;
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
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#555]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search catalog apps…"
            className="w-full bg-[#0f0f0f] border border-[#333] rounded-lg pl-9 pr-3 py-2 text-sm text-[#f2f2f2] placeholder:text-[#555] focus:outline-none focus:border-[#0078D4]/50"
          />
        </div>
        <button
          onClick={onCustom}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#333] text-[#9e9e9e] hover:text-white hover:border-[#555] text-sm transition-colors whitespace-nowrap"
        >
          <PlusCircle className="w-4 h-4" />
          <span className="hidden sm:inline">Custom URL</span>
        </button>
      </div>

      {/* Counts */}
      {!loading && (
        <p className="text-xs text-[#666]">
          {sorted.length} app{sorted.length !== 1 ? "s" : ""} in catalog
          {installedNames.size > 0 && ` · ${installedNames.size} installed`}
        </p>
      )}

      {/* Grid */}
      {loading ? (
        <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(9)].map((_, i) => (
            <div key={i} className="bg-white/[0.03] border border-white/[0.07] rounded-xl p-4 h-36 animate-pulse" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-[#555]">
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Catalog Installer (browse + wizard) ───────────────────────────────────────
function CatalogInstallerTab({ onInstalled }: { onInstalled?: () => void }) {
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
                  <button onClick={handleInstall} disabled={installing}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50">
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

interface ConversionResult {
  slug: string; tier: Tier; warnings: string[]; combinedYaml: string;
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

const QUICK_CATEGORIES = [
  { value: "", label: "All" },
  { value: "MediaServer", label: "Media Servers" },
  { value: "MediaApp", label: "Media Apps" },
  { value: "Downloaders", label: "Downloaders" },
  { value: "Network", label: "Network" },
  { value: "Productivity", label: "Productivity" },
  { value: "Tools", label: "Tools" },
  { value: "AI", label: "AI" },
  { value: "HomeAutomation", label: "Home Automation" },
  { value: "Security", label: "Security" },
  { value: "Backup", label: "Backup" },
  { value: "GameServers", label: "Game Servers" },
];

function formatDownloads(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function DeployModal({ app, onClose }: { app: AppSummary; onClose: () => void }) {
  const [step, setStep] = useState<"options" | "preview" | "deploying" | "done">("options");
  // NOTE: useTransition with async callbacks does NOT keep isPending=true for the
  // full duration of the await in React 18 — it only tracks the synchronous part.
  // Use explicit loading state instead so the spinner persists during the fetch.
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isDeployLoading, setIsDeployLoading] = useState(false);
  const isPending = isPreviewLoading || isDeployLoading;
  const [options, setOptions] = useState<DeployOptions>({
    namespace: app.slug, pvcSizeGi: 10, storageClass: "longhorn",
    ingressHost: `${app.slug}.int.rlservers.com`, createIngress: !!app.webUI,
  });
  const [preview, setPreview] = useState<ConversionResult | null>(null);
  const [deployResult, setDeployResult] = useState<{ paths: string[]; warnings: string[] } | null>(null);

  const handlePreview = async () => {
    setIsPreviewLoading(true);
    try {
      const res = await fetch("/api/community-apps/convert", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: app.name, ...options }),
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
    setIsDeployLoading(true);
    setStep("deploying");
    try {
      const res = await fetch("/api/community-apps/deploy", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appName: app.name, ...options }),
      });
      const data = await res.json() as { ok?: boolean; paths?: string[]; warnings?: string[]; error?: string };
      if (!res.ok) { toast.error(data.error ?? "Deploy failed"); setStep("preview"); return; }
      setDeployResult({ paths: data.paths ?? [], warnings: data.warnings ?? [] });
      setStep("done");
      toast.success(`${app.name} deployed! ArgoCD will sync in ~2 minutes. If it doesn't appear, the bootstrap file has been committed to git.`);
    } catch {
      toast.error("Deploy request failed");
      setStep("preview");
    } finally {
      setIsDeployLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
        className="bg-[#0d1117] border border-white/10 rounded-t-2xl sm:rounded-xl w-full sm:max-w-3xl max-h-[92dvh] sm:max-h-[90vh] flex flex-col shadow-2xl"
      >
        <div className="flex items-center justify-between p-5 border-b border-white/10 flex-shrink-0">
          <div className="flex items-center gap-3">
            {app.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={app.icon} alt="" className="w-8 h-8 rounded object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            ) : (
              <Package className="w-8 h-8 text-indigo-400" />
            )}
            <div>
              <h2 className="text-white font-semibold">{app.name}</h2>
              <p className="text-white/50 text-xs">{app.image}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-b border-white/10 flex-shrink-0">
          {(["options", "preview", "done"] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className="w-8 h-px bg-white/20" />}
              <div className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors",
                step === s ? "bg-indigo-500/20 text-indigo-400" :
                  (["options", "preview", "done"].indexOf(step) > i ? "text-white/60" : "text-white/30")
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
              <p className="text-white/70 text-sm font-medium">Generating YAML preview…</p>
              <p className="text-white/40 text-xs text-center max-w-xs">First run downloads the AppFeed index (~33MB). This may take up to 30 seconds.</p>
            </div>
          )}

          {step === "options" && !isPreviewLoading && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Namespace</label>
                  <input className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.namespace} onChange={e => setOptions(o => ({ ...o, namespace: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))} />
                </div>
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Storage Class</label>
                  <select className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.storageClass} onChange={e => setOptions(o => ({ ...o, storageClass: e.target.value }))}>
                    <option value="longhorn">longhorn</option>
                    <option value="local-path">local-path</option>
                    <option value="longhorn-retain">longhorn-retain</option>
                  </select>
                </div>
                <div>
                  <label className="text-white/60 text-xs mb-1 block">PVC Size (GiB per volume)</label>
                  <input type="number" min={1} max={10000}
                    className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.pvcSizeGi} onChange={e => setOptions(o => ({ ...o, pvcSizeGi: parseInt(e.target.value, 10) || 10 }))} />
                </div>
                <div className="flex items-start gap-3 pt-6">
                  <input type="checkbox" id="createIngress" checked={options.createIngress}
                    onChange={e => setOptions(o => ({ ...o, createIngress: e.target.checked }))} className="mt-0.5" />
                  <label htmlFor="createIngress" className="text-white/80 text-sm">Create Traefik IngressRoute</label>
                </div>
              </div>
              {options.createIngress && (
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Ingress Hostname</label>
                  <input className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.ingressHost} onChange={e => setOptions(o => ({ ...o, ingressHost: e.target.value }))} />
                  <p className="text-white/40 text-xs mt-1">Will be VPN-only via netbird-vpn-only middleware</p>
                </div>
              )}
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
              <div className="h-[380px] rounded-lg overflow-hidden border border-white/10 relative">
                {isPreviewLoading && <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e] z-10"><Loader2 className="w-6 h-6 animate-spin text-blue-400" /></div>}
                <pre className="w-full h-full bg-[#1e1e1e] text-slate-200 font-mono text-xs leading-5 p-4 overflow-auto whitespace-pre">{preview.combinedYaml}</pre>
              </div>
              <p className="text-white/40 text-xs">This YAML will be committed to <code className="bg-white/10 px-1 rounded">kubernetes/catalog/{preview.slug}/manifests/</code> and deployed by ArgoCD.</p>
            </div>
          )}

          {step === "done" && deployResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-emerald-400">
                <CheckCircle className="w-8 h-8" />
                <div>
                  <p className="font-semibold">App deployed! Bootstrap file committed to Git</p>
                  <p className="text-white/50 text-sm">ArgoCD usually shows {app.name} within ~2 minutes.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                <Info className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-indigo-200 space-y-1">
                  <p>✓ ArgoCD sync is not instant — give it about 2 minutes to appear.</p>
                  <p>If it does not show up yet, the bootstrap file was still committed to git. Check the <button onClick={onClose} className="text-indigo-300 underline hover:text-indigo-100">All Installed</button> tab again shortly.</p>
                </div>
              </div>
              <div className="bg-white/5 rounded-lg p-3 space-y-1">
                <p className="text-white/60 text-xs font-medium mb-2">Files committed:</p>
                {deployResult.paths.map(p => (
                  <div key={p} className="flex items-center gap-2 text-xs text-white/70">
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

        <div className="flex items-center justify-between p-5 border-t border-white/10 flex-shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-white/60 hover:text-white text-sm transition-colors">{step === "done" ? "Close" : "Cancel"}</button>
          <div className="flex gap-3">
            {step === "preview" && (
              <button onClick={() => setStep("options")} className="flex items-center gap-2 px-4 py-2 rounded-lg text-white/70 hover:text-white border border-white/10 hover:border-white/30 transition-colors text-sm">
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === "options" && (
              <button onClick={handlePreview} disabled={isPending}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50">
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />} Preview YAML
              </button>
            )}
            {step === "preview" && (
              <button onClick={handleDeploy} disabled={isPending}
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

function AppCard({ app, onDeploy }: { app: AppSummary; onDeploy: (app: AppSummary) => void }) {
  const tierCfg = TIER_CONFIG[app.tier];
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 transition-all duration-200 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {app.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={app.icon} alt="" className="w-8 h-8 object-contain" onError={e => {
              const el = e.target as HTMLImageElement;
              el.style.display = "none";
              el.parentElement!.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
            }} />
          ) : <Package className="w-5 h-5 text-white/30" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{app.name}</p>
          <p className="text-white/40 text-xs truncate">{app.image}</p>
        </div>
        <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0", tierCfg.color)}>
          {tierCfg.icon} {tierCfg.label}
        </span>
      </div>
      {app.overview && <p className="text-white/50 text-xs leading-relaxed line-clamp-2">{app.overview}</p>}
      <div className="flex items-center gap-2 flex-wrap">
        {(app.stars ?? 0) > 0 && <span className="flex items-center gap-1 text-white/40 text-[10px]"><Star className="w-3 h-3" /> {app.stars?.toLocaleString()}</span>}
        {(app.downloads ?? 0) > 0 && <span className="flex items-center gap-1 text-white/40 text-[10px]"><Download className="w-3 h-3" /> {formatDownloads(app.downloads)}</span>}
        {app.categories.slice(0, 2).map(cat => (
          <span key={cat} className="px-1.5 py-0.5 rounded bg-white/5 text-white/40 text-[10px]">{cat.replace(/:/g, " › ")}</span>
        ))}
      </div>
      <div className="flex gap-2 mt-auto pt-1">
        {app.support && (
          <a href={app.support} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white/50 hover:text-white border border-white/10 hover:border-white/30 transition-colors">
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
        )}
        <button onClick={() => onDeploy(app)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-indigo-600/80 hover:bg-indigo-500 text-white transition-colors">
          <Globe className="w-3 h-3" /> Deploy
        </button>
      </div>
    </motion.div>
  );
}

function CommunityStoreTab() {
  const [storeTab, setStoreTab] = useState<"store" | "installed">("store");
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [tier, setTier] = useState("");
  const [deployApp, setDeployApp] = useState<AppSummary | null>(null);
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [installed, setInstalled] = useState<{ apps: InstalledCommunityApp[]; total: number } | null>(null);
  const [installedLoading, setInstalledLoading] = useState(false);
  const [installedError, setInstalledError] = useState<string | null>(null);

  const fetchApps = useCallback(async (opts: { page: number; search: string; category: string; tier: string }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(opts.page), limit: "24",
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.category ? { category: opts.category } : {}),
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
      setInstalled(await res.json() as { apps: InstalledCommunityApp[]; total: number });
    } catch (err) {
      setInstalledError(String(err));
    } finally {
      setInstalledLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchApps({ page: 1, search: "", category: "", tier: "" });
  }, [fetchApps]);
  useEffect(() => {
    if (storeTab === "installed" && !installed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchInstalled();
    }
  }, [storeTab, installed, fetchInstalled]);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    const t = setTimeout(() => { setDebouncedSearch(value); setPage(1); void fetchApps({ page: 1, search: value, category, tier }); }, 400);
    setSearchTimeout(t);
  };

  const handleCategory = (cat: string) => { setCategory(cat); setPage(1); void fetchApps({ page: 1, search: debouncedSearch, category: cat, tier }); };
  const handleTier = (t: string) => { setTier(t); setPage(1); void fetchApps({ page: 1, search: debouncedSearch, category, tier: t }); };
  const handlePage = (p: number) => { setPage(p); void fetchApps({ page: p, search: debouncedSearch, category, tier }); };

  return (
    <div className="space-y-5">
      {/* Sub-header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white/50 text-sm">Browse 3,500+ apps from the Unraid Community Applications feed — convert and deploy to Kubernetes</p>
          {storeTab === "store" && data?.last_updated && (
            <p className="text-white/30 text-xs mt-0.5">Feed updated: {data.last_updated} · {data.total.toLocaleString()} apps</p>
          )}
          {storeTab === "installed" && installed && (
            <p className="text-white/30 text-xs mt-0.5">{installed.total} app{installed.total !== 1 ? "s" : ""} installed</p>
          )}
        </div>
        <button onClick={storeTab === "store" ? () => void fetchApps({ page, search: debouncedSearch, category, tier }) : () => { setInstalled(null); void fetchInstalled(); }}
          className="flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 transition-colors text-sm">
          <RefreshCw className={cn("w-4 h-4", (loading || installedLoading) && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* Store / Installed sub-tabs */}
      <div className="flex gap-1 p-1 bg-white/5 rounded-lg w-fit">
        <button onClick={() => setStoreTab("store")}
          className={cn("flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-all", storeTab === "store" ? "bg-indigo-600 text-white" : "text-white/50 hover:text-white")}>
          <Store className="w-4 h-4" /> Store
        </button>
        <button onClick={() => setStoreTab("installed")}
          className={cn("flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-all", storeTab === "installed" ? "bg-indigo-600 text-white" : "text-white/50 hover:text-white")}>
          <Package className="w-4 h-4" /> Installed
          {installed && installed.total > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-white/10 text-xs">{installed.total}</span>}
        </button>
      </div>

      {storeTab === "store" && (
        <>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {(Object.entries(TIER_CONFIG) as Array<[Tier, typeof TIER_CONFIG.simple]>).map(([key, cfg]) => (
              <button key={key} onClick={() => handleTier(tier === key ? "" : key)}
                className={cn("flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
                  tier === key ? cfg.color : "text-white/40 bg-white/5 border-white/10 hover:border-white/30")}>
                {cfg.icon} {cfg.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
              <input type="text" placeholder="Search apps, images, descriptions…" value={search} onChange={e => handleSearch(e.target.value)}
                className="w-full bg-white/5 border border-white/10 focus:border-indigo-500/50 rounded-lg pl-10 pr-4 py-2.5 text-white text-sm placeholder-white/30 focus:outline-none transition-colors" />
            </div>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
            {QUICK_CATEGORIES.map(cat => (
              <button key={cat.value} onClick={() => handleCategory(cat.value)}
                className={cn("flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-all border",
                  category === cat.value ? "bg-indigo-600 text-white border-indigo-500" : "text-white/50 border-white/10 hover:border-white/30 hover:text-white/80")}>
                {cat.label}
              </button>
            ))}
          </div>
          {error && <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm"><AlertTriangle className="w-4 h-4" /> {error}</div>}
          {loading && !data && <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-indigo-400 animate-spin" /></div>}
          {data && (
            <>
              <div className="flex items-center justify-between text-white/40 text-sm">
                <span>{data.total.toLocaleString()} apps{debouncedSearch ? ` matching "${debouncedSearch}"` : ""}</span>
                <span>Page {data.page} of {data.pages}</span>
              </div>
              {loading && <div className="flex justify-center"><Loader2 className="w-6 h-6 text-indigo-400 animate-spin" /></div>}
              <div className={cn("grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity", loading && "opacity-50")}>
                {data.apps.map(app => <AppCard key={app.slug + app.image} app={app} onDeploy={setDeployApp} />)}
              </div>
              {data.apps.length === 0 && !loading && (
                <div className="text-center py-16 text-white/40">
                  <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
                  <p>No apps found. Try adjusting your search or filters.</p>
                </div>
              )}
              {data.pages > 1 && (
                <div className="flex items-center justify-center gap-1.5 pt-4">
                  <button onClick={() => handlePage(page - 1)} disabled={page === 1}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm">
                    <ChevronLeft className="w-4 h-4" /><span className="hidden sm:inline">Prev</span>
                  </button>
                  <span className="sm:hidden px-3 py-2 text-white/50 text-sm">{page} / {data.pages}</span>
                  <div className="hidden sm:flex items-center gap-1.5">
                    {Array.from({ length: Math.min(7, data.pages) }, (_, i) => {
                      const p = page <= 4 ? i + 1 : page >= data.pages - 3 ? data.pages - 6 + i : page - 3 + i;
                      if (p < 1 || p > data.pages) return null;
                      return (
                        <button key={p} onClick={() => handlePage(p)}
                          className={cn("w-9 h-9 rounded-lg text-sm transition-colors", p === page ? "bg-indigo-600 text-white" : "text-white/50 hover:text-white border border-white/10 hover:border-white/30")}>
                          {p}
                        </button>
                      );
                    })}
                  </div>
                  <button onClick={() => handlePage(page + 1)} disabled={page === data.pages}
                    className="flex items-center gap-1 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm">
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
          {installedError && <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm"><AlertTriangle className="w-4 h-4" /> {installedError}</div>}
          {installedLoading && !installed && <div className="flex items-center justify-center h-64"><Loader2 className="w-8 h-8 text-indigo-400 animate-spin" /></div>}
          {installed && installed.total === 0 && (
            <div className="text-center py-20 text-white/40">
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
                  <div key={app.slug} className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 flex flex-col gap-3 transition-all duration-200">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                        <Package className="w-5 h-5 text-indigo-400/70" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-white font-medium text-sm truncate">{app.name}</p>
                        <p className="text-white/40 text-xs truncate">{app.namespace}</p>
                      </div>
                      <span className={cn("flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0", tierCfg.color)}>
                        {tierCfg.icon} {tierCfg.label}
                      </span>
                    </div>
                    {app.description && <p className="text-white/50 text-xs leading-relaxed line-clamp-2">{app.description}</p>}
                    {app.image && <p className="text-white/30 text-[10px] truncate font-mono">{app.image}</p>}
                    <div className="flex items-center gap-2 flex-wrap">
                      {app.categories.slice(0, 2).map(cat => (
                        <span key={cat} className="px-1.5 py-0.5 rounded bg-white/5 text-white/40 text-[10px]">{cat.replace(/:/g, " › ")}</span>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-auto pt-1">
                      {app.ingressHost && (
                        <a href={`https://${app.ingressHost}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white/50 hover:text-white border border-white/10 hover:border-white/30 transition-colors">
                          <ExternalLink className="w-3 h-3" /> Open
                        </a>
                      )}
                      <a href={`https://github.com/Werewolf-p/InfraWeaver-platform/tree/main/${app.manifestsPath}`} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white/50 hover:text-white border border-white/10 hover:border-white/30 transition-colors">
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
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Apps"
          icon={LayoutGrid}
          subtitle="Install and manage all platform applications"
        />
        {/* Floating + Install App button */}
        <button
          onClick={() => { setInstallSource(null); setShowInstallModal(true); }}
          className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors min-h-[40px]"
        >
          <PlusCircle className="w-4 h-4" />
          <span className="hidden sm:inline">Install App</span>
        </button>
      </div>

      {/* Top tabs */}
      <div className="flex gap-1 border-b border-[#2a2a2a]">
        {TOP_TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px",
                activeTab === tab.value
                  ? "border-[#0078D4] text-[#0078D4]"
                  : "border-transparent text-[#9e9e9e] hover:text-[#f2f2f2]"
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
              className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
              onClick={() => setShowInstallModal(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 16 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 16 }}
                transition={{ duration: 0.15 }}
                className="bg-[#1a1a1a] border border-[#333] rounded-2xl p-6 w-full max-w-sm shadow-2xl"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-5">
                  <h2 className="text-base font-semibold text-white">Choose Install Source</h2>
                  <button onClick={() => setShowInstallModal(false)} className="text-[#666] hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => { setShowInstallModal(false); setActiveTab("catalog"); }}
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border border-[#333] hover:border-indigo-500/50 hover:bg-indigo-500/10 transition-all group"
                  >
                    <Package className="w-8 h-8 text-[#9e9e9e] group-hover:text-indigo-400 transition-colors" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-white">Platform Catalog</p>
                      <p className="text-xs text-[#666] mt-0.5">Helm &amp; Git apps</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { setShowInstallModal(false); setActiveTab("community"); }}
                    className="flex flex-col items-center gap-3 p-5 rounded-xl border border-[#333] hover:border-purple-500/50 hover:bg-purple-500/10 transition-all group"
                  >
                    <Store className="w-8 h-8 text-[#9e9e9e] group-hover:text-purple-400 transition-colors" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-white">Community Store</p>
                      <p className="text-xs text-[#666] mt-0.5">3,500+ UnrAid apps</p>
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
