"use client";

import { motion, useMotionValue, animate } from "framer-motion";
import { useArgoApps } from "@/hooks/use-argocd";
import { usePlatformApps } from "@/hooks/use-platform-apps";
import {
  Box, CheckCircle2, AlertTriangle, RefreshCw, Zap,
  Loader2, Clock, Activity, HardDrive, Shield, Users, BarChart3,
  BookOpen, Network, ArrowRight, ExternalLink,
  LayoutDashboard, Terminal, Key, TrendingUp, Server,
  ChevronRight, AlertCircle,
} from "lucide-react";
import { useEffect, useMemo, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06 } },
};
const item = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } };

function AnimatedNumber({ value }: { value: number }) {
  const motionVal = useMotionValue(0);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const controls = animate(motionVal, value, {
      duration: 0.8,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return controls.stop;
  }, [value, motionVal]);

  return <>{display}</>;
}

function KpiCard({ title, value, subtitle, icon: Icon, accent, trend }: {
  title: string;
  value: number | string;
  subtitle?: string;
  icon: React.ElementType;
  accent: string;
  trend?: { value: number; label: string };
}) {
  return (
    <motion.div
      variants={item}
      whileHover={{ borderColor: "rgba(0,120,212,0.4)" }}
      className="relative overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[var(--surface-1,#1a1a1a)] p-4 touch-manipulation transition-transform active:scale-[0.98]"
    >
      <div className="mb-3 flex items-start justify-between">
        <div className={cn("flex h-9 w-9 items-center justify-center rounded-xl", accent)}>
          <Icon className="h-4 w-4" />
        </div>
        {trend ? (
          <div className={cn(
            "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            trend.value >= 0 ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400",
          )}>
            <TrendingUp className="h-2.5 w-2.5" />
            {trend.label}
          </div>
        ) : null}
      </div>
      <div className="tabular-nums text-3xl font-bold text-[var(--text-primary,#f2f2f2)]">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted,#666)]">{title}</div>
      {subtitle ? <p className="mt-1 text-xs text-[var(--text-secondary,#9e9e9e)]">{subtitle}</p> : null}
    </motion.div>
  );
}

function QuickAction({ icon: Icon, label, onClick, href, accent = "bg-[#1a1a1a] border-[#2a2a2a]", loading }: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
  href?: string;
  accent?: string;
  loading?: boolean;
}) {
  const cls = cn(
    "flex min-h-[56px] flex-col items-center justify-center gap-1.5 rounded-2xl border px-3 py-3",
    "text-xs font-medium text-[#9e9e9e] transition-all touch-manipulation",
    "hover:text-white active:scale-95",
    accent,
  );
  const content = (
    <>
      {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
      <span className="text-center leading-tight">{label}</span>
    </>
  );

  if (href) return <Link href={href} className={cls}>{content}</Link>;
  return <button type="button" onClick={onClick} className={cls} disabled={loading}>{content}</button>;
}

function AppHealthChip({ name, health }: { name: string; health: string }) {
  const isHealthy = health === "Healthy";
  const isDegraded = health === "Degraded" || health === "Missing";

  return (
    <Link href={`/apps/${name}`}>
      <div className={cn(
        "flex min-h-[32px] items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all touch-manipulation active:scale-95",
        isHealthy ? "border-green-500/20 bg-green-500/10 text-green-400"
          : isDegraded ? "border-red-500/20 bg-red-500/10 text-red-400"
            : "border-amber-500/20 bg-amber-500/10 text-amber-400",
      )}>
        <span className={cn(
          "h-1.5 w-1.5 flex-shrink-0 rounded-full",
          isHealthy ? "bg-green-400" : isDegraded ? "bg-red-400" : "bg-amber-400",
        )} />
        {name}
      </div>
    </Link>
  );
}

type ServiceStatus = "up" | "down" | "unknown";

const GATUS_KEY_MAP: Record<string, string[]> = {
  argocd: ["argocd", "argo"],
  authentik: ["authentik", "sso"],
  grafana: ["grafana"],
  netbird: ["netbird"],
  openbao: ["openbao", "vault"],
  longhorn: ["longhorn"],
  gatus: ["gatus"],
  wiki: ["wiki"],
  registry: ["registry"],
};

function resolveStatus(
  appKey: string,
  endpoints: Array<{ name: string; results?: Array<{ success: boolean }> }>,
): ServiceStatus {
  const keywords = GATUS_KEY_MAP[appKey] ?? [appKey];
  const matches = endpoints.filter((ep) => keywords.some((k) => ep.name.toLowerCase().includes(k)));
  if (matches.length === 0) return "unknown";
  const isUp = matches.every((ep) => ep.results?.[0]?.success === true);
  const isDown = matches.every((ep) => ep.results?.[0]?.success === false);
  if (isUp) return "up";
  if (isDown) return "down";
  return "unknown";
}

function PlatformServiceCard({ name, description, href, icon: Icon, status, external }: {
  name: string;
  description: string;
  href: string;
  icon: React.ElementType;
  status: ServiceStatus;
  external?: boolean;
}) {
  const Wrapper = external ? "a" : Link;
  const wrapperProps = external
    ? ({ href, target: "_blank", rel: "noopener noreferrer" } as React.AnchorHTMLAttributes<HTMLAnchorElement>)
    : ({ href } as { href: string });

  return (
    <motion.div
      variants={item}
      whileHover={{ borderColor: "rgba(0,120,212,0.4)" }}
      className="flex flex-col rounded-2xl border border-[#2a2a2a] bg-[var(--surface-1,#1a1a1a)] p-4 touch-manipulation transition-transform active:scale-[0.98]"
    >
      <div className="mb-3 flex items-start justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[rgba(0,120,212,0.15)] bg-[rgba(0,120,212,0.1)]">
          <Icon className="h-4 w-4 text-[#0078D4]" />
        </div>
        <div className={cn(
          "mt-1 flex h-2 w-2 flex-shrink-0 rounded-full",
          status === "up" ? "animate-pulse bg-green-400" : status === "down" ? "bg-red-400" : "bg-slate-500",
        )} />
      </div>
      <p className="mb-0.5 text-sm font-semibold text-[#f2f2f2]">{name}</p>
      <p className="mb-3 flex-1 text-[11px] text-[#666]">{description}</p>
      {/* @ts-expect-error polymorphic */}
      <Wrapper {...wrapperProps} className="flex w-fit items-center gap-1 text-xs text-[#0078D4] transition-colors hover:text-[#1a86d9]">
        Open {external ? <ExternalLink className="h-3 w-3" /> : <ArrowRight className="h-3 w-3" />}
      </Wrapper>
    </motion.div>
  );
}

function ArgoCDUnavailableBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-400" />
        <div>
          <p className="text-sm font-semibold text-amber-300">ArgoCD Unavailable</p>
          <p className="mt-0.5 text-xs text-amber-400/70">App data cannot be loaded. ArgoCD may be restarting or unreachable.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onRetry} className="flex min-h-[40px] items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-300 touch-manipulation transition-transform active:scale-95">
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
        <Link href="/self-test" className="flex min-h-[40px] items-center gap-2 rounded-xl border border-[#333] bg-[#1a1a1a] px-4 py-2 text-xs font-medium text-[#9e9e9e] touch-manipulation transition-transform hover:text-white active:scale-95">
          Run Diagnostics
        </Link>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data: apps, isLoading, isError, error, refetch } = useArgoApps();
  const { isAdmin } = useRBAC();
  const qc = useQueryClient();
  const [syncAllLoading, setSyncAllLoading] = useState(false);
  const platformApps = usePlatformApps();
  const scrollRef = useRef<HTMLDivElement>(null);
  const activityScrollRef = useRef<HTMLDivElement>(null);

  const { data: healthData } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      return res.json() as Promise<{ endpoints?: Array<{ name: string; results?: Array<{ success: boolean }> }>; available?: boolean; error?: string }>;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const { data: podsData } = useQuery({
    queryKey: ["pods", "homepage"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("fail");
      return res.json() as Promise<Array<{ status: string }>>;
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const endpoints = useMemo(() => healthData?.endpoints ?? [], [healthData?.endpoints]);

  const stats = useMemo(() => {
    if (!apps) return { total: 0, healthy: 0, synced: 0, degraded: 0 };
    return {
      total: apps.length,
      healthy: apps.filter((a) => a.status.health.status === "Healthy").length,
      synced: apps.filter((a) => a.status.sync.status === "Synced").length,
      degraded: apps.filter((a) => a.status.health.status === "Degraded").length,
    };
  }, [apps]);

  const podStats = useMemo(() => {
    const pods = podsData ?? [];
    return { running: pods.filter((p) => p.status === "Running").length, total: pods.length };
  }, [podsData]);

  const gatusStats = useMemo(() => {
    const up = endpoints.filter((ep) => ep.results?.[0]?.success === true).length;
    return { up, total: endpoints.length };
  }, [endpoints]);

  const recentActivity = useMemo(() => {
    if (!apps) return [];
    return [...apps]
      .sort((a, b) => {
        const aTime = a.status.operationState?.finishedAt ? new Date(a.status.operationState.finishedAt).getTime() : 0;
        const bTime = b.status.operationState?.finishedAt ? new Date(b.status.operationState.finishedAt).getTime() : 0;
        return bTime - aTime;
      })
      .slice(0, 5);
  }, [apps]);

  const appHealthChips = useMemo(() => {
    if (!apps) return [];
    return apps.slice(0, 12).map((a) => ({ name: a.metadata.name, health: a.status.health.status }));
  }, [apps]);

  const handleSyncAll = async () => {
    if (!isAdmin) {
      toast.error("Admin permission required");
      return;
    }

    setSyncAllLoading(true);
    try {
      const res = await fetch("/api/argocd/sync-all", { method: "POST" });
      const data = await res.json() as { synced?: string[]; errors?: string[]; total?: number };
      if (data.total === 0) toast.info("All apps already in sync");
      else toast.success(`Synced ${data.synced?.length ?? 0} app(s)${data.errors?.length ? `, ${data.errors.length} error(s)` : ""}`);
      qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
    } catch {
      toast.error("Sync all failed");
    } finally {
      setSyncAllLoading(false);
    }
  };

  const uptimePct = gatusStats.total > 0 ? Math.round((gatusStats.up / gatusStats.total) * 100) : 100;
  const argoErrorDetail = error instanceof Error ? error.message : undefined;

  return (
    <div>
      <PageHeader icon={LayoutDashboard} title="Dashboard" subtitle="Cluster command center — live metrics" />

      {isError ? <ArgoCDUnavailableBanner onRetry={() => void refetch()} /> : null}
      {isError && !apps?.length ? (
        <div className="mb-5 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-100">
          <p className="font-semibold">App inventory is currently unavailable.</p>
          {argoErrorDetail ? <p className="mt-1 text-red-100/80">{argoErrorDetail}</p> : null}
        </div>
      ) : null}

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3"
      >
        <KpiCard
          title="Healthy Apps"
          value={isLoading ? 0 : stats.healthy}
          subtitle={`of ${stats.total} total`}
          icon={CheckCircle2}
          accent="bg-green-500/15 text-green-400"
          trend={stats.total > 0 ? { value: stats.healthy / stats.total, label: `${Math.round((stats.healthy / stats.total) * 100)}%` } : undefined}
        />
        <KpiCard
          title="Pods Running"
          value={isLoading ? 0 : podStats.running}
          subtitle={`of ${podStats.total} total`}
          icon={Box}
          accent="bg-blue-500/15 text-blue-400"
        />
        <div className="col-span-2 lg:col-span-1">
          <KpiCard
            title="Cluster Uptime"
            value={`${uptimePct}%`}
            subtitle={`${gatusStats.up}/${gatusStats.total} endpoints up`}
            icon={Activity}
            accent="bg-violet-500/15 text-violet-400"
          />
        </div>
      </motion.div>

      <div className="mb-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-[#555]">Quick Actions</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {isAdmin ? (
            <QuickAction
              icon={Zap}
              label="Sync All"
              onClick={handleSyncAll}
              loading={syncAllLoading}
              accent="border-[rgba(0,120,212,0.2)] bg-[rgba(0,120,212,0.08)] text-[#4db3ff] hover:bg-[rgba(0,120,212,0.15)]"
            />
          ) : null}
          <QuickAction icon={Activity} label="View Logs" href="/logs" accent="border-[#2a2a2a] bg-[#1a1a1a] hover:bg-[#222]" />
          <QuickAction icon={Key} label="Manage Secrets" href="/secrets" accent="border-[#2a2a2a] bg-[#1a1a1a] hover:bg-[#222]" />
          <QuickAction icon={Terminal} label="Open Terminal" href="/pod-shell" accent="border-[#2a2a2a] bg-[#1a1a1a] hover:bg-[#222]" />
          {!isAdmin ? <QuickAction icon={Server} label="Cluster" href="/cluster" accent="border-[#2a2a2a] bg-[#1a1a1a] hover:bg-[#222]" /> : null}
        </div>
      </div>

      {(appHealthChips.length > 0 || isLoading) ? (
        <div className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-[#555]">App Health</h2>
            <Link href="/apps" className="text-xs text-[#0078D4] transition-colors hover:text-[#1a86d9]">View all</Link>
          </div>
          {isLoading ? (
            <div className="flex gap-2 overflow-x-hidden">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="h-8 w-24 flex-shrink-0 rounded-full bg-[#1a1a1a] shimmer-bg" />
              ))}
            </div>
          ) : (
            <div
              ref={scrollRef}
              className="flex snap-x gap-2 overflow-x-auto pb-1 scroll-smooth"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              {appHealthChips.map((chip) => (
                <div key={chip.name} className="snap-start flex-shrink-0">
                  <AppHealthChip name={chip.name} health={chip.health} />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-[#2a2a2a] bg-[var(--surface-1,#1a1a1a)] p-4 sm:p-5 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-[#f2f2f2]">
              <Clock className="h-4 w-4 text-[#9e9e9e]" />
              Recent Activity
            </h3>
            <Link href="/apps" className="text-xs text-[#0078D4] transition-colors hover:text-[#1a86d9]">All apps</Link>
          </div>
          <div ref={activityScrollRef} className="space-y-0.5">
            {isLoading ? (
              [...Array(5)].map((_, i) => <div key={i} className="h-12 rounded-xl shimmer-bg" />)
            ) : recentActivity.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#555]">No recent activity</p>
            ) : recentActivity.map((app) => (
              <Link key={app.metadata.name} href={`/apps/${app.metadata.name}`}>
                <div className="flex min-h-[52px] items-center justify-between rounded-xl px-3 py-2 transition-all hover:bg-[#222] touch-manipulation active:scale-[0.99]">
                  <span className="mr-3 truncate text-sm font-medium text-[#f2f2f2]">{app.metadata.name}</span>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <StatusBadge status={app.status.health.status} size="sm" />
                    {app.status.operationState?.finishedAt ? (
                      <span className="hidden text-xs text-[#666] sm:block">
                        {timeAgo(app.status.operationState.finishedAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {stats.degraded > 0 ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 text-red-400" />
                <span className="text-sm font-semibold text-red-300">Attention Required</span>
              </div>
              <p className="mb-3 text-xs text-red-400/80">{stats.degraded} app{stats.degraded > 1 ? "s" : ""} in degraded state</p>
              <Link href="/apps?filter=degraded" className="flex items-center gap-1 text-xs text-red-400 transition-colors hover:text-red-300">
                View degraded apps <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          ) : null}
          <div className="space-y-3 rounded-2xl border border-[#2a2a2a] bg-[var(--surface-1,#1a1a1a)] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-[#555]">Cluster Stats</h3>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#9e9e9e]">Apps Synced</span>
                <span className="tabular-nums text-sm font-semibold text-[#f2f2f2]">{stats.synced}/{stats.total}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#9e9e9e]">Pods Running</span>
                <span className="tabular-nums text-sm font-semibold text-[#f2f2f2]">{podStats.running}/{podStats.total}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[#9e9e9e]">Endpoints Up</span>
                <span className="tabular-nums text-sm font-semibold text-[#f2f2f2]">{gatusStats.up}/{gatusStats.total}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f2f2f2]">
            <Activity className="h-4 w-4 text-[#9e9e9e]" />
            Platform Services
          </h2>
          {healthData?.available === false ? (
            <span className="flex items-center gap-1 text-xs text-amber-400/70">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              monitoring unavailable
            </span>
          ) : null}
        </div>

        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4"
        >
          {platformApps.gatus ? <PlatformServiceCard name="Gatus" description="Endpoint monitoring" href="/health" icon={Activity} status={resolveStatus("gatus", endpoints)} /> : null}
          {platformApps.longhorn ? <PlatformServiceCard name="Longhorn" description="Distributed storage" href="/storage" icon={HardDrive} status={resolveStatus("longhorn", endpoints)} /> : null}
          {platformApps.netbird ? <PlatformServiceCard name="NetBird" description="WireGuard overlay VPN" href="/network" icon={Network} status={resolveStatus("netbird", endpoints)} /> : null}
          {platformApps.openbao ? <PlatformServiceCard name="OpenBao" description="Secrets management" href="/security" icon={Shield} status={resolveStatus("openbao", endpoints)} /> : null}
          {platformApps.authentik ? <PlatformServiceCard name="Authentik" description="Identity & SSO" href="/security" icon={Users} status={resolveStatus("authentik", endpoints)} /> : null}
          {platformApps.grafana ? <PlatformServiceCard name="Grafana" description="Metrics & dashboards" href="/health" icon={BarChart3} status={resolveStatus("grafana", endpoints)} /> : null}
          {platformApps.wiki ? <PlatformServiceCard name="Wiki" description="Internal knowledge base" href="/health" icon={BookOpen} status={resolveStatus("wiki", endpoints)} /> : null}
          {platformApps.registry ? <PlatformServiceCard name="Registry" description="Container image registry" href="/registry" icon={HardDrive} status={resolveStatus("registry", endpoints)} /> : null}
        </motion.div>
      </div>
    </div>
  );
}
