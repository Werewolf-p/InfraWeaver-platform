"use client";

import { useState, useCallback, useTransition, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search, Package, ExternalLink, AlertTriangle, Info, CheckCircle,
  Loader2, Globe, ChevronLeft, ChevronRight, RefreshCw, Terminal,
  Download, Star, X, Shield, Zap, GitBranch, Eye
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

// ── types ────────────────────────────────────────────────────────────────────

type Tier = "simple" | "medium" | "complex";

interface AppSummary {
  name: string;
  slug: string;
  image: string;
  icon?: string;
  overview?: string;
  categories: string[];
  tier: Tier;
  stars?: number;
  downloads?: number;
  webUI?: string;
  support?: string;
  configCount: number;
}

interface FeedResponse {
  apps: AppSummary[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  last_updated: string;
  last_updated_timestamp: number;
  categories: Array<{ Cat: string; Des: string }>;
}

interface ConversionResult {
  slug: string;
  tier: Tier;
  warnings: string[];
  combinedYaml: string;
}

interface DeployOptions {
  namespace: string;
  pvcSizeGi: number;
  storageClass: string;
  ingressHost: string;
  createIngress: boolean;
}

// ── tier UI helpers ──────────────────────────────────────────────────────────

const TIER_CONFIG: Record<Tier, { label: string; color: string; icon: React.ReactNode; description: string }> = {
  simple: {
    label: "K8s Ready",
    color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
    icon: <CheckCircle className="w-3 h-3" />,
    description: "Standard container — deploys directly to Kubernetes",
  },
  medium: {
    label: "Custom Network",
    color: "text-amber-400 bg-amber-400/10 border-amber-400/30",
    icon: <Zap className="w-3 h-3" />,
    description: "Uses custom Docker networking — verify service discovery",
  },
  complex: {
    label: "Privileged",
    color: "text-red-400 bg-red-400/10 border-red-400/30",
    icon: <Shield className="w-3 h-3" />,
    description: "Requires privileged mode or host devices — review carefully",
  },
};

// ── category filter options ──────────────────────────────────────────────────

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

// ── download formatting ──────────────────────────────────────────────────────

function formatDownloads(n?: number): string {
  if (!n) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── deploy modal ─────────────────────────────────────────────────────────────

function DeployModal({
  app,
  onClose,
}: {
  app: AppSummary;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"options" | "preview" | "deploying" | "done">("options");
  const [isPending, startTransition] = useTransition();
  const [options, setOptions] = useState<DeployOptions>({
    namespace: app.slug,
    pvcSizeGi: 10,
    storageClass: "longhorn",
    ingressHost: `${app.slug}.int.rlservers.com`,
    createIngress: !!app.webUI,
  });
  const [preview, setPreview] = useState<ConversionResult | null>(null);
  const [deployResult, setDeployResult] = useState<{ paths: string[]; warnings: string[] } | null>(null);

  const handlePreview = () => {
    startTransition(async () => {
      try {
        const res = await fetch("/api/community-apps/convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appName: app.name, ...options }),
        });
        const data = await res.json() as ConversionResult & { error?: string };
        if (!res.ok) { toast.error(data.error ?? "Conversion failed"); return; }
        setPreview(data);
        setStep("preview");
      } catch {
        toast.error("Failed to generate preview");
      }
    });
  };

  const handleDeploy = () => {
    setStep("deploying");
    startTransition(async () => {
      try {
        const res = await fetch("/api/community-apps/deploy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appName: app.name, ...options }),
        });
        const data = await res.json() as { ok?: boolean; paths?: string[]; warnings?: string[]; error?: string };
        if (!res.ok) {
          toast.error(data.error ?? "Deploy failed");
          setStep("preview");
          return;
        }
        setDeployResult({ paths: data.paths ?? [], warnings: data.warnings ?? [] });
        setStep("done");
        toast.success(`${app.name} committed to Git — ArgoCD will deploy it shortly`);
      } catch {
        toast.error("Deploy request failed");
        setStep("preview");
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="bg-[#0d1117] border border-white/10 rounded-t-2xl sm:rounded-xl w-full sm:max-w-3xl max-h-[92dvh] sm:max-h-[90vh] flex flex-col shadow-2xl"
      >
        {/* Header */}
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
          <button onClick={onClose} className="text-white/40 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step progress */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-white/10 flex-shrink-0">
          {(["options", "preview", "done"] as const).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <div className="w-8 h-px bg-white/20" />}
              <div className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors",
                step === s ? "bg-indigo-500/20 text-indigo-400" :
                  (["options", "preview", "done"].indexOf(step) > i ? "text-white/60" : "text-white/30")
              )}>
                <span className="w-4 h-4 rounded-full border flex items-center justify-center text-[10px]
                  border-current">{i + 1}</span>
                {s === "options" ? "Configure" : s === "preview" ? "Review YAML" : "Done"}
              </div>
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {step === "options" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Namespace</label>
                  <input
                    className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.namespace}
                    onChange={e => setOptions(o => ({ ...o, namespace: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") }))}
                  />
                </div>
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Storage Class</label>
                  <select
                    className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.storageClass}
                    onChange={e => setOptions(o => ({ ...o, storageClass: e.target.value }))}
                  >
                    <option value="longhorn">longhorn</option>
                    <option value="local-path">local-path</option>
                    <option value="longhorn-retain">longhorn-retain</option>
                  </select>
                </div>
                <div>
                  <label className="text-white/60 text-xs mb-1 block">PVC Size (GiB per volume)</label>
                  <input
                    type="number" min={1} max={10000}
                    className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.pvcSizeGi}
                    onChange={e => setOptions(o => ({ ...o, pvcSizeGi: parseInt(e.target.value, 10) || 10 }))}
                  />
                </div>
                <div className="flex items-start gap-3 pt-6">
                  <input
                    type="checkbox" id="createIngress"
                    checked={options.createIngress}
                    onChange={e => setOptions(o => ({ ...o, createIngress: e.target.checked }))}
                    className="mt-0.5"
                  />
                  <label htmlFor="createIngress" className="text-white/80 text-sm">Create Traefik IngressRoute</label>
                </div>
              </div>
              {options.createIngress && (
                <div>
                  <label className="text-white/60 text-xs mb-1 block">Ingress Hostname</label>
                  <input
                    className="w-full bg-white/5 border border-white/10 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                    value={options.ingressHost}
                    onChange={e => setOptions(o => ({ ...o, ingressHost: e.target.value }))}
                  />
                  <p className="text-white/40 text-xs mt-1">Will be VPN-only via netbird-vpn-only middleware</p>
                </div>
              )}

              {/* Tier warning */}
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
              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="space-y-2">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className={cn(
                      "flex gap-2 p-2.5 rounded-lg border text-xs",
                      w.startsWith("⚠️") ? "text-amber-400 bg-amber-400/10 border-amber-400/20" :
                        "text-blue-400 bg-blue-400/10 border-blue-400/20"
                    )}>
                      <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="h-[380px] rounded-lg overflow-hidden border border-white/10">
                <MonacoEditor
                  height="100%"
                  language="yaml"
                  value={preview.combinedYaml}
                  theme="vs-dark"
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 12,
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
              <p className="text-white/40 text-xs">
                This YAML will be committed to <code className="bg-white/10 px-1 rounded">kubernetes/catalog/{preview.slug}/manifests/</code> and deployed by ArgoCD.
              </p>
            </div>
          )}

          {step === "done" && deployResult && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-emerald-400">
                <CheckCircle className="w-8 h-8" />
                <div>
                  <p className="font-semibold">Successfully committed to Git</p>
                  <p className="text-white/50 text-sm">ArgoCD will deploy {app.name} within ~60 seconds</p>
                </div>
              </div>
              <div className="bg-white/5 rounded-lg p-3 space-y-1">
                <p className="text-white/60 text-xs font-medium mb-2">Files committed:</p>
                {deployResult.paths.map(p => (
                  <div key={p} className="flex items-center gap-2 text-xs text-white/70">
                    <GitBranch className="w-3 h-3 text-indigo-400" />
                    <code>{p}</code>
                  </div>
                ))}
              </div>
              {deployResult.warnings.length > 0 && (
                <div className="space-y-1">
                  {deployResult.warnings.map((w, i) => (
                    <p key={i} className="text-amber-400 text-xs">{w}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-5 border-t border-white/10 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-white/60 hover:text-white text-sm transition-colors"
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>

          <div className="flex gap-3">
            {step === "preview" && (
              <button
                onClick={() => setStep("options")}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-white/70 hover:text-white border border-white/10 hover:border-white/30 transition-colors text-sm"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === "options" && (
              <button
                onClick={handlePreview}
                disabled={isPending}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                Preview YAML
              </button>
            )}
            {step === "preview" && (
              <button
                onClick={handleDeploy}
                disabled={isPending}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Terminal className="w-4 h-4" />}
                Deploy to Cluster
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ── app card ─────────────────────────────────────────────────────────────────

function AppCard({ app, onDeploy }: { app: AppSummary; onDeploy: (app: AppSummary) => void }) {
  const tierCfg = TIER_CONFIG[app.tier];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.07] hover:border-white/20 rounded-xl p-4 transition-all duration-200 flex flex-col gap-3"
    >
      {/* Top row: icon + name + tier */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
          {app.icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={app.icon} alt=""
              className="w-8 h-8 object-contain"
              onError={e => {
                const el = e.target as HTMLImageElement;
                el.style.display = "none";
                el.parentElement!.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>';
              }}
            />
          ) : (
            <Package className="w-5 h-5 text-white/30" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-medium text-sm truncate">{app.name}</p>
          <p className="text-white/40 text-xs truncate">{app.image}</p>
        </div>
        <span className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium flex-shrink-0",
          tierCfg.color
        )}>
          {tierCfg.icon} {tierCfg.label}
        </span>
      </div>

      {/* Overview */}
      {app.overview && (
        <p className="text-white/50 text-xs leading-relaxed line-clamp-2">{app.overview}</p>
      )}

      {/* Stats + categories */}
      <div className="flex items-center gap-2 flex-wrap">
        {(app.stars ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-white/40 text-[10px]">
            <Star className="w-3 h-3" /> {app.stars?.toLocaleString()}
          </span>
        )}
        {(app.downloads ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-white/40 text-[10px]">
            <Download className="w-3 h-3" /> {formatDownloads(app.downloads)}
          </span>
        )}
        {app.categories.slice(0, 2).map(cat => (
          <span key={cat} className="px-1.5 py-0.5 rounded bg-white/5 text-white/40 text-[10px]">
            {cat.replace(/:/g, " › ")}
          </span>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto pt-1">
        {app.support && (
          <a
            href={app.support} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-white/50 hover:text-white border border-white/10 hover:border-white/30 transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
        )}
        <button
          onClick={() => onDeploy(app)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-indigo-600/80 hover:bg-indigo-500 text-white transition-colors"
        >
          <Globe className="w-3 h-3" /> Deploy
        </button>
      </div>
    </motion.div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function CommunityAppsPage() {
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

  const fetchApps = useCallback(async (opts: {
    page: number;
    search: string;
    category: string;
    tier: string;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(opts.page),
        limit: "24",
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.tier ? { tier: opts.tier } : {}),
      });
      const res = await fetch(`/api/community-apps?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as FeedResponse;
      setData(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on mount
  useEffect(() => {
    void fetchApps({ page: 1, search: "", category: "", tier: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (value: string) => {
    setSearch(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    const t = setTimeout(() => {
      setDebouncedSearch(value);
      setPage(1);
      void fetchApps({ page: 1, search: value, category, tier });
    }, 400);
    setSearchTimeout(t);
  };

  const handleCategory = (cat: string) => {
    setCategory(cat);
    setPage(1);
    void fetchApps({ page: 1, search: debouncedSearch, category: cat, tier });
  };

  const handleTier = (t: string) => {
    setTier(t);
    setPage(1);
    void fetchApps({ page: 1, search: debouncedSearch, category, tier: t });
  };

  const handlePage = (p: number) => {
    setPage(p);
    void fetchApps({ page: p, search: debouncedSearch, category, tier });
  };

  const handleRefresh = () => {
    void fetchApps({ page, search: debouncedSearch, category, tier });
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-white">Community Apps</h1>
          <p className="text-white/50 text-xs sm:text-sm mt-1">
            Browse 3,500+ apps from the Unraid Community Applications feed — convert and deploy to Kubernetes
          </p>
          {data?.last_updated && (
            <p className="text-white/30 text-xs mt-0.5">
              Feed updated: {data.last_updated} · {data.total.toLocaleString()} apps
            </p>
          )}
        </div>
        <button
          onClick={handleRefresh}
          className="flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 transition-colors text-sm"
          title="Refresh"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      {/* Tier legend */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {(Object.entries(TIER_CONFIG) as Array<[Tier, typeof TIER_CONFIG.simple]>).map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => handleTier(tier === key ? "" : key)}
            className={cn(
              "flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all",
              tier === key ? cfg.color : "text-white/40 bg-white/5 border-white/10 hover:border-white/30"
            )}
          >
            {cfg.icon} {cfg.label}
          </button>
        ))}
      </div>

      {/* Search + filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/40" />
          <input
            type="text"
            placeholder="Search apps, images, descriptions…"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            className="w-full bg-white/5 border border-white/10 focus:border-indigo-500/50 rounded-lg pl-10 pr-4 py-2.5 text-white text-sm placeholder-white/30 focus:outline-none transition-colors"
          />
        </div>
      </div>

      {/* Category pills */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {QUICK_CATEGORIES.map(cat => (
          <button
            key={cat.value}
            onClick={() => handleCategory(cat.value)}
            className={cn(
              "flex-shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-all border",
              category === cat.value
                ? "bg-indigo-600 text-white border-indigo-500"
                : "text-white/50 border-white/10 hover:border-white/30 hover:text-white/80"
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Results */}
      {error && (
        <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
        </div>
      )}

      {data && (
        <>
          <div className="flex items-center justify-between text-white/40 text-sm">
            <span>{data.total.toLocaleString()} apps{debouncedSearch ? ` matching "${debouncedSearch}"` : ""}</span>
            <span>Page {data.page} of {data.pages}</span>
          </div>

          {loading && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
            </div>
          )}

          <div className={cn(
            "grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity",
            loading && "opacity-50"
          )}>
            {data.apps.map(app => (
              <AppCard key={app.slug + app.image} app={app} onDeploy={setDeployApp} />
            ))}
          </div>

          {data.apps.length === 0 && !loading && (
            <div className="text-center py-16 text-white/40">
              <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No apps found. Try adjusting your search or filters.</p>
            </div>
          )}

          {/* Pagination */}
          {data.pages > 1 && (
            <div className="flex items-center justify-center gap-1.5 pt-4">
              <button
                onClick={() => handlePage(page - 1)}
                disabled={page === 1}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
              >
                <ChevronLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Prev</span>
              </button>

              {/* Mobile: current / total. Desktop: numbered buttons */}
              <span className="sm:hidden px-3 py-2 text-white/50 text-sm">
                {page} / {data.pages}
              </span>

              <div className="hidden sm:flex items-center gap-1.5">
                {Array.from({ length: Math.min(7, data.pages) }, (_, i) => {
                  const p = page <= 4 ? i + 1 :
                    page >= data.pages - 3 ? data.pages - 6 + i :
                      page - 3 + i;
                  if (p < 1 || p > data.pages) return null;
                  return (
                    <button
                      key={p}
                      onClick={() => handlePage(p)}
                      className={cn(
                        "w-9 h-9 rounded-lg text-sm transition-colors",
                        p === page
                          ? "bg-indigo-600 text-white"
                          : "text-white/50 hover:text-white border border-white/10 hover:border-white/30"
                      )}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => handlePage(page + 1)}
                disabled={page === data.pages}
                className="flex items-center gap-1 px-3 py-2 rounded-lg text-white/60 hover:text-white border border-white/10 hover:border-white/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      )}

      {/* Deploy modal */}
      <AnimatePresence>
        {deployApp && (
          <DeployModal app={deployApp} onClose={() => setDeployApp(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
