"use client";
import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  GitBranch, Network, HardDrive, KeyRound, BarChart3, Activity,
  Shield, Wifi, BookOpen, HeartPulse, GitMerge, FileText, Package,
  Globe, ChevronDown, Search, RefreshCw, ExternalLink, Home,
  Zap, CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { PageHeader } from "@/components/ui/page-header";

// ─── Service definitions ────────────────────────────────────────────────────

interface Service {
  name: string;
  href: string;
  pingUrl?: string;
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
      { name: "ArgoCD", href: "https://argocd.int.rlservers.com", pingUrl: "http://argocd-server.argocd.svc.cluster.local", icon: GitBranch, description: "GitOps continuous delivery", color: "text-orange-400" },
      { name: "Traefik", href: "https://traefik.int.rlservers.com", pingUrl: "http://traefik.traefik.svc.cluster.local:8080/ping", icon: Network, description: "Ingress & reverse proxy", color: "text-cyan-400" },
      { name: "Longhorn", href: "https://longhorn.int.rlservers.com", pingUrl: "http://longhorn-frontend.longhorn-system.svc.cluster.local", icon: HardDrive, description: "Distributed block storage", color: "text-green-400" },
      { name: "OpenBao", href: "https://openbao.int.rlservers.com", pingUrl: "http://openbao.openbao.svc.cluster.local:8200/v1/sys/health", icon: KeyRound, description: "Secrets & key management", color: "text-yellow-400" },
      { name: "Grafana", href: "https://grafana.int.rlservers.com", pingUrl: "http://grafana-apps.apps-grafana.svc.cluster.local", icon: BarChart3, description: "Metrics & dashboards", color: "text-orange-300" },
      { name: "Prometheus", href: "https://prometheus.int.rlservers.com", pingUrl: "http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090/-/healthy", icon: Activity, description: "Metrics collection & alerting", color: "text-red-400" },
    ],
  },
  {
    label: "Security & Identity",
    services: [
      { name: "Authentik", href: "https://auth.rlservers.com", pingUrl: "http://authentik-server.authentik.svc.cluster.local/-/health/ready/", icon: Shield, description: "Identity provider & SSO", color: "text-indigo-400" },
      { name: "NetBird VPN", href: "https://netbird.int.rlservers.com", pingUrl: "http://netbird-management.netbird.svc.cluster.local/api/v1/health", icon: Wifi, description: "Mesh VPN network", color: "text-blue-400" },
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

// Collect only services with a pingUrl
const PINGABLE = SERVICE_GROUPS.flatMap(g => g.services).filter(s => s.pingUrl);

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
    <form onSubmit={handleSearch} className="relative flex-1 max-w-md">
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

type PingStatus = { ok: boolean; latencyMs: number };

function StatusDot({ status }: { status: PingStatus | undefined | "loading" }) {
  if (status === "loading") {
    return <span className="w-2 h-2 rounded-full bg-slate-600 animate-pulse inline-block" />;
  }
  if (!status) return <span className="w-2 h-2 rounded-full bg-slate-600 inline-block" />;
  return (
    <span className={cn(
      "w-2 h-2 rounded-full inline-block",
      status.ok ? "bg-green-500" : "bg-red-500"
    )} />
  );
}

function ServiceCard({
  service,
  pingStatus,
  index,
}: {
  service: Service;
  pingStatus: PingStatus | undefined | "loading";
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

        {service.pingUrl && (
          <div className="flex items-center gap-2">
            <StatusDot status={pingStatus} />
            {pingStatus === "loading" ? (
              <span className="text-xs text-[#666]">Checking…</span>
            ) : pingStatus ? (
              pingStatus.ok ? (
                <>
                  <span className="text-xs text-green-400">Online</span>
                  <span className="ml-auto text-xs text-[#666] font-mono">{pingStatus.latencyMs}ms</span>
                </>
              ) : (
                <span className="text-xs text-red-400">Offline</span>
              )
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
  pingData,
  isLoading,
}: {
  group: ServiceGroup;
  pingData: Record<string, PingStatus>;
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pb-1">
              {isLoading
                ? group.services.map((_, i) => <SkeletonCard key={i} index={i} />)
                : group.services.map((svc, i) => (
                    <ServiceCard
                      key={svc.name}
                      service={svc}
                      pingStatus={svc.pingUrl ? (pingData[svc.pingUrl] ?? "loading") : undefined}
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
  const [syncing, setSyncing] = useState(false);

  const handleSyncAll = async () => {
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
        disabled={syncing}
        className="flex items-center gap-2 px-4 py-2 bg-[rgba(0,120,212,0.1)] border border-[rgba(0,120,212,0.2)] rounded-xl text-sm text-[#0078D4] hover:bg-[rgba(0,120,212,0.2)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
        className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border border-green-500/20 rounded-xl text-sm text-green-400 hover:bg-green-500/20 transition-all"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        Cluster Health
      </a>

      <div className="flex items-center gap-2 ml-auto">
        {quickLinks.map(link => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center gap-1.5 px-3 py-2 bg-[#2a2a2a] border border-[#333] rounded-lg text-xs hover:bg-[#333] transition-all",
              link.color
            )}
          >
            <link.icon className="w-3.5 h-3.5" />
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

const ALL_CATEGORIES = ["All", ...SERVICE_GROUPS.map(g => g.label)];

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
      return { healthy, total: apps.length };
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
      className="grid grid-cols-3 gap-3 relative z-10"
    >
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 flex items-center gap-3">
        <div className={cn(
          "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0",
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
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-[rgba(0,120,212,0.1)] flex items-center justify-center flex-shrink-0">
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
      <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-orange-500/15 flex items-center justify-center flex-shrink-0">
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

export default function HomePortalPage() {
  const { data: session } = useSession();
  const [activeCategory, setActiveCategory] = useState("All");

  const pingUrls = PINGABLE.map(s => s.pingUrl as string);

  const { data: pingData, isLoading: pingLoading, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["homepage-ping"],
    queryFn: async () => {
      const res = await fetch(`/api/homepage-ping?urls=${encodeURIComponent(pingUrls.join(","))}`);
      if (!res.ok) throw new Error("Ping failed");
      const json = await res.json() as { results: Record<string, PingStatus> };
      return json.results;
    },
    refetchInterval: 30000,
    staleTime: 25000,
  });

  const onlineCount = pingData
    ? Object.values(pingData).filter(v => v.ok).length
    : 0;
  const totalPingable = PINGABLE.length;
  const totalServices = SERVICE_GROUPS.flatMap(g => g.services).length;

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;

  const greeting = useCallback(() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const filteredGroups = activeCategory === "All"
    ? SERVICE_GROUPS
    : SERVICE_GROUPS.filter(g => g.label === activeCategory);

  return (
    <div className="space-y-6 max-w-screen-2xl mx-auto">
      <PageHeader icon={Home} title="Home" subtitle="Platform services and quick access" />

      {/* Hero section */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10"
      >
        <div className="p-6 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight gradient-text">
                InfraWeaver Platform
              </h1>
              <p className="text-sm text-[#9e9e9e]">
                {greeting()}, <span className="text-[#f2f2f2] font-medium">{session?.user?.name?.split(" ")[0] ?? "there"}</span> 👋
              </p>
            </div>

            {/* Animated stats */}
            <div className="flex items-center gap-6">
              <div className="text-center">
                <div className="text-2xl font-bold text-[#f2f2f2] tabular-nums">
                  <AnimatedNumber value={onlineCount} duration={800} />
                  <span className="text-[#666] text-lg">/{totalPingable}</span>
                </div>
                <p className="text-[10px] text-[#666] uppercase tracking-wider mt-0.5">Online</p>
              </div>
              <div className="w-px h-10 bg-[#333]" />
              <div className="text-center">
                <div className="text-2xl font-bold text-[#f2f2f2] tabular-nums">
                  <AnimatedNumber value={totalServices} duration={600} />
                </div>
                <p className="text-[10px] text-[#666] uppercase tracking-wider mt-0.5">Services</p>
              </div>
              <div className="w-px h-10 bg-[#333]" />
              <div className="text-center">
                <div className="text-2xl font-bold tabular-nums">
                  <AnimatedNumber
                    value={totalPingable > 0 ? Math.round((onlineCount / totalPingable) * 100) : 0}
                    duration={900}
                    suffix="%"
                    className={onlineCount === totalPingable && totalPingable > 0 ? "text-emerald-400" : "text-amber-400"}
                  />
                </div>
                <p className="text-[10px] text-[#666] uppercase tracking-wider mt-0.5">Uptime</p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 w-full sm:w-auto">
              <SearchBar />
              <div className="flex items-center gap-3">
                <button
                  onClick={() => refetch()}
                  className="p-2 rounded-lg bg-[#2a2a2a] border border-[#333] text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#333] transition-all"
                  title="Refresh ping status"
                >
                  <RefreshCw className={cn("w-4 h-4", pingLoading && "animate-spin")} />
                </button>
                <Clock />
              </div>
            </div>
          </div>

          {lastUpdated && (
            <p className="text-[10px] text-[#555] mt-3">
              Last updated: {lastUpdated}
            </p>
          )}
        </div>
      </motion.div>

      {/* Quick actions */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="relative z-10 p-4 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl"
      >
        <QuickActions />
      </motion.div>

      {/* Quick stats — pods, ArgoCD, cluster health */}
      <QuickStats />

      {/* Category filter bar */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="relative z-10 flex items-center gap-2 flex-wrap"
      >
        {ALL_CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
              activeCategory === cat
                ? "bg-[rgba(0,120,212,0.15)] border border-[rgba(0,120,212,0.2)] text-[#0078D4]"
                : "bg-[#2a2a2a] border border-[#2a2a2a] text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#2a2a2a]"
            )}
          >
            {cat}
          </button>
        ))}
      </motion.div>

      {/* Service groups */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="relative z-10 space-y-6"
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeCategory}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="space-y-6"
          >
            {filteredGroups.map(group => (
              <GroupSection
                key={group.label}
                group={group}
                pingData={pingData ?? {}}
                isLoading={pingLoading && !pingData}
              />
            ))}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
