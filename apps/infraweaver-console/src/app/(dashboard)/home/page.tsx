"use client";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Network, HardDrive, KeyRound, BarChart3, Activity,
  Shield, Wifi, BookOpen, HeartPulse, GitMerge, FileText, Package,
  Globe, ChevronDown, Search, RefreshCw, ExternalLink, Home,
  Zap, CheckCircle2, AlertTriangle, History, ListChecks,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { PageHeader } from "@/components/ui/page-header";
import { WidgetCard } from "@/components/ui/widget-card";
import { DashboardPanel } from "@/components/ui/dashboard-panel";
import { DashboardStatCard } from "@/components/ui/dashboard-stat-card";
import { ToolbarSearchInput } from "@/components/ui/toolbar-search-input";
import { AutoRefreshControl } from "@/components/ui/auto-refresh-control";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedBar } from "@/components/ui/segmented-bar";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { useFavorites } from "@/hooks/use-favorites";
import { useRecentPages } from "@/hooks/use-recent-pages";
import { useRBAC } from "@/hooks/use-rbac";
import { ALL_NAV_ITEMS } from "@/lib/nav-config";
import Link from "next/link";
import { Star } from "lucide-react";
import type { HomepageServiceHealth } from "@/lib/homepage-service-config";

// ─── Service definitions ────────────────────────────────────────────────────

interface Service {
  name: string;
  href: string;
  icon: React.ElementType;
  description: string;
  color: string;
}

interface ServiceGroup {
  label: string;
  services: Service[];
}

const SERVICE_GROUPS: ServiceGroup[] = [
  {
    label: "Platform Infrastructure",
    services: [
      { name: "ArgoCD", href: "https://argocd.int.rlservers.com", icon: GitBranch, description: "GitOps continuous delivery", color: "text-orange-400" },
      { name: "Traefik", href: "https://traefik.int.rlservers.com", icon: Network, description: "Ingress & reverse proxy", color: "text-cyan-400" },
      { name: "Longhorn", href: "https://longhorn.int.rlservers.com", icon: HardDrive, description: "Distributed block storage", color: "text-green-400" },
      { name: "OpenBao", href: "https://openbao.int.rlservers.com", icon: KeyRound, description: "Secrets & key management", color: "text-yellow-400" },
      { name: "Grafana", href: "https://grafana.int.rlservers.com", icon: BarChart3, description: "Metrics & dashboards", color: "text-orange-300" },
      { name: "Prometheus", href: "https://prometheus.int.rlservers.com", icon: Activity, description: "Metrics collection & alerting", color: "text-red-400" },
    ],
  },
  {
    label: "Security & Identity",
    services: [
      { name: "Authentik", href: "https://auth.rlservers.com", icon: Shield, description: "Identity provider & SSO", color: "text-indigo-400" },
      { name: "NetBird VPN", href: "https://netbird.int.rlservers.com", icon: Wifi, description: "Mesh VPN network", color: "text-blue-400" },
    ],
  },
  {
    label: "Catalog Apps",
    services: [
      { name: "InfraWeaver", href: "https://infraweaver.int.rlservers.com", icon: Home, description: "Infrastructure management console", color: "text-violet-400" },
      { name: "Wiki.js", href: "https://wiki.int.rlservers.com", icon: BookOpen, description: "Documentation & knowledge base", color: "text-emerald-400" },
      { name: "Gatus", href: "https://status.rlservers.com", icon: HeartPulse, description: "Uptime & status monitoring", color: "text-pink-400" },
      { name: "OneDev", href: "https://onedev.int.rlservers.com", icon: GitMerge, description: "All-in-one DevOps platform", color: "text-sky-400" },
      { name: "Stirling PDF", href: "https://stirling-pdf.int.rlservers.com", icon: FileText, description: "PDF manipulation toolkit", color: "text-amber-400" },
      { name: "Container Registry", href: "https://registry.int.rlservers.com", icon: Package, description: "Private OCI image registry", color: "text-teal-400" },
    ],
  },
  {
    label: "Websites",
    services: [
      { name: "rlservers.com", href: "https://rlservers.com", icon: Globe, description: "Main website", color: "text-slate-400" },
      { name: "degoudentijd", href: "https://degoudentijd.rlservers.com", icon: Globe, description: "De Gouden Tijd website", color: "text-slate-400" },
      { name: "feestinhetdonker", href: "https://feestinhetdonker.rlservers.com", icon: Globe, description: "Feest in het Donker website", color: "text-slate-400" },
      { name: "yonavaarwater.nl", href: "https://yonavaarwater.nl", icon: Globe, description: "Yona Vaarwater website", color: "text-slate-400" },
      { name: "zonnevaarwater.nl", href: "https://zonnevaarwater.nl", icon: Globe, description: "Zonne Vaarwater website", color: "text-slate-400" },
    ],
  },
];

// ─── Sub-components ─────────────────────────────────────────────────────────

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="flex flex-col items-center sm:items-end">
      <span className="text-2xl font-bold text-[#f2f2f2] tabular-nums tracking-tight">{time}</span>
      <span className="text-xs text-[#9e9e9e]">{date}</span>
    </div>
  );
}

function SearchBar() {
  const [query, setQuery] = useState("");
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      window.open(`https://www.google.com/search?q=${encodeURIComponent(query.trim())}`, "_blank");
      setQuery("");
    }
  };

  return (
    <form onSubmit={handleSearch} className="relative w-full sm:flex-1 sm:max-w-md">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Search Google…"
        className="w-full pl-10 pr-4 py-2.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl text-sm text-[#f2f2f2] placeholder-[#555] focus:outline-none focus:border-[#0078D4]/50 focus:bg-[#1a1a1a] transition-all"
      />
    </form>
  );
}

type HealthStatus = HomepageServiceHealth;

function getHealthTextClass(status: HomepageServiceHealth["status"]) {
  if (status === "healthy") return "text-green-400";
  if (status === "degraded") return "text-amber-400";
  return "text-red-400";
}

function getHealthLabel(status: HealthStatus) {
  if (status.status === "healthy") return "Healthy";
  return status.reason ?? (status.status === "degraded" ? "Degraded" : "Offline");
}

function StatusDot({ status }: { status: HealthStatus | undefined | "loading" }) {
  if (status === "loading") {
    return <span className="w-2 h-2 rounded-full bg-slate-600 animate-pulse inline-block" />;
  }
  if (!status) return <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />;
  return (
    <span className={cn(
      "w-2 h-2 rounded-full inline-block",
      status.status === "healthy"
        ? "bg-green-500"
        : status.status === "degraded"
          ? "bg-amber-500"
          : "bg-red-500"
    )} />
  );
}

function ServiceCard({
  service,
  healthStatus,
  index,
}: {
  service: Service;
  healthStatus: HealthStatus | undefined | "loading";
  index: number;
}) {
  return (
    <motion.a
      href={service.href}
      target="_blank"
      rel="noopener noreferrer"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: index * 0.04, ease: "easeOut" }}
      className="group block bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl flex flex-col gap-3 p-4 hover:border-[rgba(0,120,212,0.5)] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className={cn("p-2 rounded-lg bg-[#2a2a2a] border border-[#333] group-hover:border-[rgba(0,120,212,0.3)] transition-colors", service.color)}>
              <service.icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#f2f2f2] truncate">{service.name}</p>
              <p className="text-xs text-[#666] truncate">{service.description}</p>
            </div>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-[#555] group-hover:text-[#9e9e9e] flex-shrink-0 mt-0.5 transition-colors" />
        </div>

        {healthStatus !== undefined && (
          <div className="flex items-center gap-2">
            <StatusDot status={healthStatus} />
            {healthStatus === "loading" ? (
              <span className="text-xs text-[#666]">Checking…</span>
            ) : healthStatus ? (
              <span className={cn("text-xs", getHealthTextClass(healthStatus.status))}>
                {getHealthLabel(healthStatus)}
              </span>
            ) : (
              <span className="text-xs text-[#666]">—</span>
            )}
          </div>
        )}
    </motion.a>
  );
}

function SkeletonCard({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.03 }}
      className="flex flex-col gap-3 p-4 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl"
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-[#2a2a2a] animate-pulse" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-24 bg-[#2a2a2a] rounded animate-pulse" />
          <div className="h-2.5 w-36 bg-[#1e1e1e] rounded animate-pulse" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-[#2a2a2a] animate-pulse" />
        <div className="h-2.5 w-12 bg-[#2a2a2a] rounded animate-pulse" />
      </div>
    </motion.div>
  );
}

function GroupSection({
  group,
  healthData,
  isLoading,
}: {
  group: ServiceGroup;
  healthData: Record<string, HealthStatus>;
  isLoading: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 group w-full text-left"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-[#666] group-hover:text-[#9e9e9e] transition-colors">
          {group.label}
        </span>
        <span className="text-[10px] font-mono text-[#555] bg-[#2a2a2a] px-1.5 py-0.5 rounded">
          {group.services.length}
        </span>
        <div className="flex-1 h-px bg-[#2a2a2a]" />
        <ChevronDown className={cn(
          "w-3.5 h-3.5 text-[#555] group-hover:text-[#9e9e9e] transition-all duration-200",
          open ? "" : "-rotate-90"
        )} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-3 pb-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {isLoading
                ? group.services.map((_, i) => <SkeletonCard key={i} index={i} />)
                  : group.services.map((svc, i) => (
                    <ServiceCard
                      key={svc.name}
                      service={svc}
                      healthStatus={isLoading ? "loading" : healthData[svc.name]}
                      index={i}
                    />
                  ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Quick Actions ───────────────────────────────────────────────────────────

function QuickActions() {
  const { can } = useRBAC();
  const canSyncAll = can("apps:sync");
  const [syncing, setSyncing] = useState(false);

  const handleSyncAll = async () => {
    if (!canSyncAll) {
      toast.error("You do not have permission to sync apps");
      return;
    }
    setSyncing(true);
    try {
      const res = await fetch("/api/argocd/sync-all", { method: "POST" });
      if (res.ok) {
        toast.success("Sync triggered for all ArgoCD apps");
      } else {
        toast.error("Failed to trigger sync");
      }
    } catch {
      toast.error("Failed to trigger sync");
    } finally {
      setSyncing(false);
    }
  };

  const quickLinks = [
    { label: "ArgoCD", href: "https://argocd.int.rlservers.com", icon: GitBranch, color: "text-orange-400" },
    { label: "Grafana", href: "https://grafana.int.rlservers.com", icon: BarChart3, color: "text-orange-300" },
    { label: "Status", href: "https://status.rlservers.com", icon: HeartPulse, color: "text-pink-400" },
    { label: "Longhorn", href: "https://longhorn.int.rlservers.com", icon: HardDrive, color: "text-green-400" },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        onClick={handleSyncAll}
        disabled={syncing || !canSyncAll}
        className="flex min-h-[40px] items-center gap-2 rounded-xl border border-[rgba(0,120,212,0.2)] bg-[rgba(0,120,212,0.1)] px-4 py-2 text-sm text-[#0078D4] transition-all hover:bg-[rgba(0,120,212,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {syncing ? (
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Zap className="w-3.5 h-3.5" />
        )}
        Sync All Apps
      </button>

      <a
        href="/health"
        className="flex min-h-[40px] items-center gap-2 rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-2 text-sm text-green-400 transition-all hover:bg-green-500/20"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        Cluster Health
      </a>

      <div className="w-full overflow-x-auto scrollbar-none sm:ml-auto sm:w-auto">
        <div className="flex w-max items-center gap-2 sm:w-auto">
          {quickLinks.map(link => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#333] bg-[#2a2a2a] px-3 py-2 text-xs transition-all hover:bg-[#333]",
                link.color
              )}
            >
              <link.icon className="w-3.5 h-3.5" />
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const ALL_CATEGORIES = ["All", ...SERVICE_GROUPS.map(g => g.label)];
const CHECKLIST_STORAGE_KEY = "infraweaver:setup-checklist";

function readChecklistState() {
  if (typeof window === "undefined") return {} as Record<string, boolean>;
  try {
    return JSON.parse(localStorage.getItem(CHECKLIST_STORAGE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {} as Record<string, boolean>;
  }
}

function QuickStats() {
  const { data: pods } = useQuery({
    queryKey: ["pods", "home"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      return res.json() as Promise<Array<{ status: string }>>;
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const { data: argoApps } = useQuery({
    queryKey: ["argocd", "apps", "home"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) return null;
      const apps = await res.json() as Array<{ status?: { health?: { status?: string } } }>;
      const healthy = apps.filter(a => a.status?.health?.status === "Healthy").length;
      const issues = apps.filter(a => ["Degraded", "Failed", "Missing"].includes(a.status?.health?.status ?? "")).length;
      return { healthy, total: apps.length, issues };
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const { data: cluster } = useQuery({
    queryKey: ["health", "cluster", "home"],
    queryFn: async () => {
      const res = await fetch("/api/health/cluster");
      return res.json() as Promise<{ status: string }>;
    },
    refetchInterval: 60000,
    staleTime: 50000,
  });

  const runningPods = (pods ?? []).filter(p => p.status === "Running").length;
  const totalPods = (pods ?? []).length;
  const isHealthy = !cluster || cluster.status === "healthy";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.08 }}
      className="relative z-10 grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      <div className="col-span-1 flex items-center gap-3 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3 sm:p-4">
        <div className={cn(
          "h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center",
          isHealthy ? "bg-green-500/15" : "bg-red-500/15"
        )}>
          <Activity className={cn("w-4 h-4", isHealthy ? "text-green-400" : "text-red-400")} />
        </div>
        <div>
          <p className="text-xs text-[#666] uppercase tracking-wider">Cluster</p>
          <p className={cn("text-sm font-semibold", isHealthy ? "text-green-400" : "text-red-400")}>
            {isHealthy ? "Healthy" : "Degraded"}
          </p>
        </div>
      </div>
      <div className="col-span-1 flex items-center gap-3 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3 sm:p-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(0,120,212,0.1)]">
          <Package className="w-4 h-4 text-[#0078D4]" />
        </div>
        <div>
          <p className="text-xs text-[#666] uppercase tracking-wider">Pods</p>
          <p className="text-sm font-semibold text-[#f2f2f2] tabular-nums">
            {totalPods > 0 ? (
              <>
                <AnimatedNumber value={runningPods} duration={600} className="text-[#f2f2f2]" />
                <span className="text-[#666]">/{totalPods}</span>
              </>
            ) : <span className="text-[#666]">—</span>}
          </p>
        </div>
      </div>
      <div className="col-span-2 flex items-center gap-3 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3 sm:col-span-1 sm:p-4">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-orange-500/15">
          <GitBranch className="w-4 h-4 text-orange-400" />
        </div>
        <div>
          <p className="text-xs text-[#666] uppercase tracking-wider">ArgoCD Apps</p>
          <p className="text-sm font-semibold text-[#f2f2f2] tabular-nums">
            {argoApps ? (
              <>
                <AnimatedNumber value={argoApps.healthy} duration={600} className="text-green-400" />
                <span className="text-[#666]">/{argoApps.total}</span>
              </>
            ) : <span className="text-[#666]">—</span>}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

function SetupChecklist({ recentPages }: { recentPages: Array<{ href: string; title: string; visitedAt: number }> }) {
  const [manualChecks, setManualChecks] = useState<Record<string, boolean>>(() => readChecklistState());

  const { data: dnsData } = useQuery({
    queryKey: ["dns", "home-checklist"],
    queryFn: async () => {
      const res = await fetch("/api/dns", { cache: "no-store" });
      if (!res.ok) return { records: [] as Array<unknown> };
      return res.json() as Promise<{ records: Array<unknown> }>;
    },
    staleTime: 60000,
  });

  const { data: gameHubServers } = useQuery({
    queryKey: ["game-hub", "servers", "home-checklist"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers", { cache: "no-store" });
      if (!res.ok) return { servers: [] as Array<unknown> };
      return res.json() as Promise<{ servers: Array<unknown> }>;
    },
    staleTime: 60000,
  });

  useEffect(() => {
    localStorage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify(manualChecks));
  }, [manualChecks]);

  const items = [
    {
      id: "vpn",
      title: "Verify VPN / network access",
      description: "Open the network pages and confirm your internal routes are reachable.",
      href: "/network",
      complete: manualChecks.vpn || recentPages.some((page) => page.href.startsWith("/network")),
    },
    {
      id: "server",
      title: "Create your first game server",
      description: "Use Game Hub to deploy a server with recommended defaults.",
      href: "/game-hub/new",
      complete: manualChecks.server || (gameHubServers?.servers?.length ?? 0) > 0,
    },
    {
      id: "dns",
      title: "Create a DNS record",
      description: "Add an internal VPN name or public hostname in the new DNS Manager.",
      href: "/dns",
      complete: manualChecks.dns || (dnsData?.records?.length ?? 0) > 0,
    },
  ];

  const completed = items.filter((item) => item.complete).length;

  return (
    <WidgetCard title="Setup Checklist" icon={ListChecks}>
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between text-sm">
          <p className="text-slate-300">Recommended first steps for new operators.</p>
          <span className="rounded-full border border-white/10 bg-[#141414] px-2 py-1 text-xs text-slate-400">
            {completed}/{items.length} complete
          </span>
        </div>
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-[#141414] p-3">
            <button
              onClick={() => setManualChecks((current) => ({ ...current, [item.id]: !item.complete }))}
              className={cn(
                "mt-0.5 flex h-5 w-5 items-center justify-center rounded border transition",
                item.complete
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                  : "border-white/10 bg-black/20 text-slate-500 hover:text-white",
              )}
              title={item.complete ? "Mark incomplete" : "Mark complete"}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className={cn("font-medium", item.complete ? "text-emerald-200" : "text-white")}>{item.title}</p>
                {item.complete ? <span className="text-xs text-emerald-300">Done</span> : null}
              </div>
              <p className="mt-1 text-sm text-slate-500">{item.description}</p>
            </div>
            <Link href={item.href} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-cyan-200 transition hover:text-white">
              Open
            </Link>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

export default function HomePortalPage() {
  const { data: session } = useSession();
  const [activeCategory, setActiveCategory] = useState("All");
  const [serviceQuery, setServiceQuery] = useState("");
  const [serviceStateFilter, setServiceStateFilter] = useState<"all" | "healthy" | "degraded" | "offline">("all");
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const searchRef = useRef<HTMLInputElement>(null);
  const { prefs } = useUserPreferences();
  const { favorites } = useFavorites();
  const { recentPages } = useRecentPages();
  const favNavItems = ALL_NAV_ITEMS.filter(item => favorites.some(f => f.href === item.href));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (event.key === "/" && !isTypingTarget) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setServiceQuery("");
        setServiceStateFilter("all");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const { data: argoApps } = useQuery({
    queryKey: ["argocd", "apps", "home-portal"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) return null;
      const apps = await res.json() as Array<{ status?: { health?: { status?: string } } }>;
      const healthy = apps.filter(a => a.status?.health?.status === "Healthy").length;
      const issues = apps.filter(a => ["Degraded", "Failed", "Missing"].includes(a.status?.health?.status ?? "")).length;
      return { healthy, total: apps.length, issues };
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const healthQuery = useQuery({
    queryKey: ["homepage-health"],
    queryFn: async () => {
      const res = await fetch("/api/homepage-health");
      if (!res.ok) throw new Error("Failed to load homepage service health");
      return res.json() as Promise<Record<string, HealthStatus>>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const statusQuery = useQuery({
    queryKey: ["platform", "status", "home"],
    queryFn: async () => {
      const res = await fetch("/api/platform/status");
      if (!res.ok) throw new Error("Failed to load platform status");
      return res.json() as Promise<{ status: string; metrics: { totalNodes: number; readyNodes: number; uptime: string } }>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const eventsQuery = useQuery({
    queryKey: ["events", "home"],
    queryFn: async () => {
      const res = await fetch("/api/events");
      if (!res.ok) throw new Error("Failed to load recent activity");
      return res.json() as Promise<{
        events: Array<{
          name: string;
          namespace: string;
          reason: string;
          message: string;
          type: string;
          count: number;
          lastTimestamp: string | null;
          involvedObject: { kind: string; name: string };
        }>;
      }>;
    },
    refetchInterval: refreshInterval || false,
    staleTime: 15000,
  });

  const healthData = useMemo(() => healthQuery.data ?? {}, [healthQuery.data]);
  const statusCounts = useMemo(() => {
    const counts = { healthy: 0, degraded: 0, offline: 0 };
    for (const service of SERVICE_GROUPS.flatMap(group => group.services)) {
      const status = healthData[service.name]?.status ?? "offline";
      if (status === "healthy") counts.healthy += 1;
      else if (status === "degraded") counts.degraded += 1;
      else counts.offline += 1;
    }
    return counts;
  }, [healthData]);

  const onlineCount = statusCounts.healthy;
  const totalServices = SERVICE_GROUPS.flatMap(g => g.services).length;
  const lastUpdated = healthQuery.dataUpdatedAt
    ? new Date(healthQuery.dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;
  const warningEvents = (eventsQuery.data?.events ?? []).filter(event => event.type === "Warning").slice(0, 5);

  const greeting = useCallback(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const filteredGroups = useMemo(() => {
    const query = serviceQuery.trim().toLowerCase();
    const groups = activeCategory === "All"
      ? SERVICE_GROUPS
      : SERVICE_GROUPS.filter(g => g.label === activeCategory);

    return groups
      .map(group => ({
        ...group,
        services: group.services.filter((service) => {
          const status = healthData[service.name]?.status ?? "offline";
          const matchesQuery = !query || service.name.toLowerCase().includes(query) || service.description.toLowerCase().includes(query);
          const matchesState = serviceStateFilter === "all" || status === serviceStateFilter;
          return matchesQuery && matchesState;
        }),
      }))
      .filter(group => group.services.length > 0);
  }, [activeCategory, healthData, serviceQuery, serviceStateFilter]);

  const quickActionCards = [
    { href: "/monitoring", icon: HeartPulse, title: "Monitoring", description: "Open alert summary, charts, and SLA.", tone: "border-rose-500/20 bg-rose-500/10 text-rose-200" },
    { href: "/apps", icon: GitBranch, title: "Apps", description: "Review sync drift and app health fast.", tone: "border-indigo-500/20 bg-indigo-500/10 text-indigo-200" },
    { href: "/cluster", icon: Activity, title: "Cluster", description: "Inspect nodes, quotas, and maintenance actions.", tone: "border-emerald-500/20 bg-emerald-500/10 text-emerald-200" },
    { href: "/events", icon: History, title: "Recent Activity", description: "See the latest warning and sync events.", tone: "border-amber-500/20 bg-amber-500/10 text-amber-200" },
  ];

  return (
    <div className="mx-auto max-w-screen-2xl space-y-4 sm:space-y-6">
      <PageHeader
        icon={Home}
        title="Home"
        subtitle="Platform services, health, and quick operator actions"
        actions={<AutoRefreshControl interval={refreshInterval} onChange={setRefreshInterval} onRefreshNow={() => { void healthQuery.refetch(); void eventsQuery.refetch(); void statusQuery.refetch(); }} />}
      />

      {argoApps && argoApps.issues > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:hidden flex items-center gap-3 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl text-sm text-red-400"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{argoApps.issues} app{argoApps.issues > 1 ? "s" : ""} need attention</span>
          <Link href="/apps" className="ml-auto text-xs underline">View</Link>
        </motion.div>
      )}

      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10"
      >
        <div className="rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-4 sm:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="space-y-1">
              <h1 className="text-xl sm:text-3xl font-extrabold tracking-tight gradient-text">
                InfraWeaver Platform
              </h1>
              <p className="text-sm text-[#9e9e9e]">
                {greeting()}, <span className="text-[#f2f2f2] font-medium">{session?.user?.name?.split(" ")[0] ?? "there"}</span> 👋
              </p>
              <p className="max-w-2xl text-sm text-[#888]">
                Real-time desktop landing zone for service health, operator tasks, and the latest cluster activity.
              </p>
            </div>

            <div className="flex w-full flex-col gap-4 xl:max-w-xl">
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-[#2a2a2a] bg-[#141414] px-4 py-3 text-center">
                  <div className="text-xl font-bold text-[#f2f2f2] tabular-nums sm:text-2xl">
                    <AnimatedNumber value={onlineCount} duration={800} />
                    <span className="text-[#666] text-lg">/{totalServices}</span>
                  </div>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-[#666]">Healthy services</p>
                </div>
                <div className="rounded-2xl border border-[#2a2a2a] bg-[#141414] px-4 py-3 text-center">
                  <div className="text-xl font-bold text-[#f2f2f2] tabular-nums sm:text-2xl">
                    <AnimatedNumber value={warningEvents.length} duration={600} />
                  </div>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-[#666]">Warnings</p>
                </div>
                <div className="rounded-2xl border border-[#2a2a2a] bg-[#141414] px-4 py-3 text-center">
                  <div className="text-xl font-bold tabular-nums sm:text-2xl">
                    <AnimatedNumber
                      value={totalServices > 0 ? Math.round((statusCounts.healthy / totalServices) * 100) : 0}
                      duration={900}
                      suffix="%"
                      className={statusCounts.offline === 0 ? "text-emerald-400" : "text-amber-400"}
                    />
                  </div>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-[#666]">Availability</p>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <SearchBar />
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#2a2a2a] bg-[#141414] px-3 py-2 sm:min-w-[220px]">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[#666]">Live status</p>
                    <p className="text-sm text-[#d4d4d4]">{statusQuery.data?.status ?? "checking"}</p>
                  </div>
                  <Clock />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[#666]">
            {lastUpdated ? <span>Last service refresh: {lastUpdated}</span> : null}
            <RefreshCountdown intervalSeconds={Math.max(15, Math.round((refreshInterval || 30000) / 1000))} resetKey={healthQuery.dataUpdatedAt} />
            <span>{statusQuery.data ? `${statusQuery.data.metrics.readyNodes}/${statusQuery.data.metrics.totalNodes} nodes ready` : "Checking nodes"}</span>
          </div>
        </div>
      </motion.div>

      <DashboardPanel title="System health summary" description="Most important platform signals above the fold, with service distribution and follow-up hints." icon={Activity}>
        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
            <DashboardStatCard
              label="Platform services"
              value={`${statusCounts.healthy}/${totalServices}`}
              icon={Activity}
              tone={statusCounts.offline > 0 ? "warning" : "success"}
              description="Healthy services across the full portal catalog."
              footer={<span>{statusCounts.degraded} degraded · {statusCounts.offline} offline</span>}
            />
            <DashboardStatCard
              label="ArgoCD apps"
              value={argoApps ? `${argoApps.healthy}/${argoApps.total}` : "—"}
              icon={GitBranch}
              tone={(argoApps?.issues ?? 0) > 0 ? "warning" : "info"}
              description="GitOps applications reporting healthy status."
              footer={<span>{argoApps?.issues ?? 0} issue(s) currently flagged</span>}
            />
            <DashboardStatCard
              label="Recent warnings"
              value={warningEvents.length}
              icon={AlertTriangle}
              tone={warningEvents.length > 0 ? "danger" : "success"}
              description="Latest warning-level cluster events surfaced from the activity feed."
              footer={<span>{eventsQuery.data?.events?.length ?? 0} recent events fetched</span>}
            />
            <DashboardStatCard
              label="Cluster readiness"
              value={statusQuery.data ? `${statusQuery.data.metrics.readyNodes}/${statusQuery.data.metrics.totalNodes}` : "—"}
              icon={Package}
              tone={statusQuery.data?.status === "operational" ? "success" : "warning"}
              description={`Platform status is ${statusQuery.data?.status ?? "updating"}.`}
              footer={<span>Reported uptime {statusQuery.data?.metrics.uptime ?? "—"}</span>}
            />
          </div>

          <div className="rounded-2xl border border-[#2a2a2a] bg-[#141414] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-[#f2f2f2]">Service distribution</p>
                <p className="text-xs text-[#888]">Healthy, degraded, and offline services update with the same auto-refresh cadence as the page.</p>
              </div>
              <Link href="/monitoring" className="rounded-lg border border-[#2a2a2a] px-3 py-1.5 text-xs text-[#9e9e9e] transition hover:text-white">
                Open monitoring
              </Link>
            </div>
            <div className="mt-4">
              <SegmentedBar
                segments={[
                  { label: "Healthy", value: statusCounts.healthy, className: "bg-emerald-500" },
                  { label: "Degraded", value: statusCounts.degraded, className: "bg-amber-500" },
                  { label: "Offline", value: statusCounts.offline, className: "bg-red-500" },
                ]}
              />
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {[
                  { label: "Healthy", value: statusCounts.healthy, tone: "text-emerald-300" },
                  { label: "Degraded", value: statusCounts.degraded, tone: "text-amber-300" },
                  { label: "Offline", value: statusCounts.offline, tone: "text-red-300" },
                ].map(item => (
                  <div key={item.label} className="rounded-xl border border-[#2a2a2a] bg-[#111] p-3">
                    <p className="text-[11px] uppercase tracking-[0.18em] text-[#666]">{item.label}</p>
                    <p className={`mt-2 text-2xl font-semibold ${item.tone}`}>{item.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 rounded-xl border border-[#2a2a2a] bg-[#111] p-3 text-sm text-[#b8b8b8]">
                <p className="font-medium text-white">Operator shortcuts</p>
                <ul className="mt-2 space-y-1.5 text-sm text-[#888]">
                  <li><span className="text-white">/</span> focuses service search.</li>
                  <li><span className="text-white">Esc</span> clears local service filters.</li>
                  <li>Use the quick action cards to jump straight into the right workflow.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </DashboardPanel>

      <DashboardPanel title="Quick action cards" description="One-click operator paths for the most common desktop workflows." icon={Zap}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {quickActionCards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className={cn("rounded-2xl border p-4 transition hover:border-white/20 hover:-translate-y-0.5", card.tone)}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-white/10 bg-black/20 p-2">
                  <card.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="font-semibold text-white">{card.title}</p>
                  <p className="mt-1 text-sm text-[#b8b8b8]">{card.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </DashboardPanel>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="relative z-10 rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] p-3 sm:p-4"
      >
        <QuickActions />
      </motion.div>

      <QuickStats />

      <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
        <DashboardPanel title="Recent activity" description="Latest warning and normal events pulled into the landing page so you do not have to open the full activity log first." icon={History}>
          {eventsQuery.isLoading ? (
            <div className="space-y-3">{[0, 1, 2, 3].map(index => <div key={index} className="h-20 animate-pulse rounded-2xl bg-[#111]" />)}</div>
          ) : warningEvents.length === 0 && (eventsQuery.data?.events?.length ?? 0) === 0 ? (
            <EmptyState icon={History} title="No recent activity" description="The cluster event feed is quiet right now." className="py-10" />
          ) : (
            <div className="space-y-3">
              {(eventsQuery.data?.events ?? []).slice(0, 5).map(event => (
                <div key={`${event.namespace}-${event.name}-${event.lastTimestamp}`} className="rounded-2xl border border-[#2a2a2a] bg-[#141414] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]", event.type === "Warning" ? "bg-amber-500/15 text-amber-200" : "bg-[#0d0d0d] text-[#888]")}>{event.reason}</span>
                        <span className="text-xs text-[#888]">{event.namespace}</span>
                        <span className="text-xs text-[#666]">{event.involvedObject.kind}/{event.involvedObject.name}</span>
                      </div>
                      <p className="mt-2 text-sm text-[#f2f2f2]">{event.message}</p>
                    </div>
                    <div className="text-right text-xs text-[#888]">
                      <p>x{event.count}</p>
                      <p>{event.lastTimestamp ? timeAgo(event.lastTimestamp) : "now"}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DashboardPanel>

        <div className={cn("grid gap-4", recentPages.length > 0 ? "xl:grid-cols-[1.1fr_0.9fr]" : "") }>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="relative z-10"
          >
            {recentPages.length > 0 ? (
              <WidgetCard title="Recently Viewed" icon={History}>
                <div className="p-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {recentPages.slice(0, 5).map((page) => (
                    <Link
                      key={`${page.href}-${page.visitedAt}`}
                      href={page.href}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#141414] px-3 py-3 text-sm transition hover:border-[rgba(0,120,212,0.3)] hover:bg-[rgba(0,120,212,0.05)]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-white">{page.title}</p>
                        <p className="mt-1 truncate text-xs text-slate-500">{page.href}</p>
                      </div>
                      <span className="shrink-0 text-xs text-slate-500">{timeAgo(new Date(page.visitedAt))}</span>
                    </Link>
                  ))}
                </div>
              </WidgetCard>
            ) : (
              <DashboardPanel title="Recently viewed" description="Your navigation history will populate this card as you move through the console." icon={History}>
                <EmptyState icon={History} title="No recent pages yet" description="Visit an application, cluster, or monitoring screen to start building your operator trail." className="py-10" />
              </DashboardPanel>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.14 }}
            className="relative z-10"
          >
            <SetupChecklist recentPages={recentPages} />
          </motion.div>
        </div>
      </div>

      <DashboardPanel title="Service explorer" description="Filter by category, health state, or search query without leaving the portal overview." icon={HeartPulse}>
        <div className="space-y-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-1 flex-col gap-3 md:flex-row md:items-center">
              <ToolbarSearchInput
                ref={searchRef}
                value={serviceQuery}
                onChange={setServiceQuery}
                placeholder="Search service cards by name or description…"
                className="flex-1"
              />
              <div className="flex flex-wrap gap-2">
                {([
                  { value: "all", label: "All" },
                  { value: "healthy", label: "Healthy" },
                  { value: "degraded", label: "Degraded" },
                  { value: "offline", label: "Offline" },
                ] as const).map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setServiceStateFilter(option.value)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                      serviceStateFilter === option.value
                        ? "border-[#0078D4]/40 bg-[rgba(0,120,212,0.15)] text-[#9dcbff]"
                        : "border-[#2a2a2a] bg-[#111] text-[#888] hover:text-[#f2f2f2]"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <RefreshCountdown intervalSeconds={Math.max(15, Math.round((refreshInterval || 30000) / 1000))} resetKey={healthQuery.dataUpdatedAt} />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {ALL_CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={cn(
                  "min-h-[40px] rounded-lg px-3 py-1.5 text-xs font-medium transition-all",
                  activeCategory === cat
                    ? "bg-[rgba(0,120,212,0.15)] border border-[rgba(0,120,212,0.2)] text-[#0078D4]"
                    : "bg-[#2a2a2a] border border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a]"
                )}
              >
                {cat}
              </button>
            ))}
          </div>

          {healthQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Service health failed to load"
              description={healthQuery.error instanceof Error ? healthQuery.error.message : "Try refreshing the page."}
              action={{ label: "Retry", onClick: () => void healthQuery.refetch() }}
              className="py-10"
            />
          ) : null}
        </div>
      </DashboardPanel>

      {prefs.widgets["platform-services"] && !healthQuery.isError && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="relative z-10 space-y-4 sm:space-y-6"
        >
          <WidgetCard title="Platform Services">
            <div className="p-3 sm:p-4">
              <AnimatePresence mode="wait">
                <motion.div
                  key={`${activeCategory}-${serviceStateFilter}-${serviceQuery}`}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.15 }}
                  className="space-y-6"
                >
                  {healthQuery.isLoading && !healthQuery.data ? (
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                      {[0, 1, 2, 3, 4, 5].map((item) => <SkeletonCard key={item} index={item} />)}
                    </div>
                  ) : filteredGroups.length > 0 ? (
                    filteredGroups.map(group => (
                      <GroupSection
                        key={group.label}
                        group={group}
                        healthData={healthData}
                        isLoading={healthQuery.isLoading && !healthQuery.data}
                      />
                    ))
                  ) : (
                    <EmptyState
                      icon={HeartPulse}
                      title="No services match these filters"
                      description="Clear your search or change the health-state filter to show more services."
                      action={{ label: "Reset filters", onClick: () => { setServiceQuery(""); setServiceStateFilter("all"); setActiveCategory("All"); } }}
                      className="py-10"
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </WidgetCard>
        </motion.div>
      )}

      {prefs.widgets["quick-links"] && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="relative z-10"
        >
          {favNavItems.length > 0 ? (
            <WidgetCard title="Pinned Pages" icon={Star}>
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 sm:p-4 lg:grid-cols-4">
                {favNavItems.map(item => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center gap-2 p-2.5 rounded-lg bg-[#141414] border border-[#2a2a2a] hover:border-[rgba(0,120,212,0.3)] hover:bg-[rgba(0,120,212,0.05)] transition-all text-sm text-[#9e9e9e] hover:text-[#f2f2f2]"
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0 text-[#0078D4]" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                ))}
              </div>
            </WidgetCard>
          ) : (
            <DashboardPanel title="Pinned pages" description="Pin important screens from the sidebar to keep them here on the home portal." icon={Star}>
              <EmptyState icon={Star} title="No pinned pages yet" description="Use the star icon in the sidebar to pin apps, cluster, or monitoring pages here." className="py-10" />
            </DashboardPanel>
          )}
        </motion.div>
      )}
    </div>
  );
}
