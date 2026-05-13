"use client";
import { motion, useMotionValue, animate } from "framer-motion";
import { useArgoApps } from "@/hooks/use-argocd";
import { usePlatformApps } from "@/hooks/use-platform-apps";
import { NamespaceUsage } from "@/components/ui/namespace-usage";
import {
  Box, CheckCircle2, AlertTriangle, RefreshCw, Zap, CheckCircle, XCircle,
  Loader2, Clock, Activity, HardDrive, Shield, Users, BarChart3,
  BookOpen, Package, Network, ArrowRight, ExternalLink, Container, LayoutDashboard,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const item = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };

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

function StatCard({ title, value, icon: Icon, color, subtitle }: {
  title: string; value: number | string; icon: React.ElementType; color: string; subtitle?: string;
}) {
  return (
    <motion.div
      variants={item}
      whileHover={{ borderColor: "rgba(0,120,212,0.5)" }}
      transition={{ duration: 0.2 }}
      className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-3 md:p-5 cursor-default active:scale-95 touch-manipulation"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-[#9e9e9e] font-medium">{title}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-bold text-[#f2f2f2]">
        {typeof value === "number" ? <AnimatedNumber value={value} /> : value}
      </div>
      {subtitle && <p className="text-xs text-[#666] mt-1">{subtitle}</p>}
    </motion.div>
  );
}

function ConnectionPill({ label, url }: { label: string; url: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["conn", label],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("fail");
      return true;
    },
    retry: 1,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  return (
    <div className={cn(
      "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border",
      isLoading ? "bg-[#2a2a2a] border-[#333] text-[#9e9e9e]"
        : isError ? "bg-red-500/10 border-red-500/20 text-red-400"
        : "bg-green-500/10 border-green-500/20 text-green-400"
    )}>
      {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : isError ? <XCircle className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
      {label}
    </div>
  );
}

type ServiceStatus = "up" | "down" | "unknown";

function StatusDot({ status }: { status: ServiceStatus }) {
  return (
    <div className={cn(
      "w-2 h-2 rounded-full flex-shrink-0",
      status === "up" ? "bg-green-400 live-dot" : status === "down" ? "bg-red-400" : "bg-slate-500"
    )} title={status} />
  );
}

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
  endpoints: Array<{ name: string; results?: Array<{ success: boolean }> }>
): ServiceStatus {
  const keywords = GATUS_KEY_MAP[appKey] ?? [appKey];
  const matches = endpoints.filter(ep =>
    keywords.some(k => ep.name.toLowerCase().includes(k))
  );
  if (matches.length === 0) return "unknown";
  const isUp = matches.every(ep => ep.results?.[0]?.success === true);
  const isDown = matches.every(ep => ep.results?.[0]?.success === false);
  if (isUp) return "up";
  if (isDown) return "down";
  return "unknown";
}

function ServiceCard({ name, description, href, icon: Icon, enabled, status, external }: {
  name: string; description: string; href: string; icon: React.ElementType;
  enabled: boolean; status?: ServiceStatus; external?: boolean;
}) {
  if (!enabled) return null;
  const cardStatus = status ?? "unknown";
  const Wrapper = external ? "a" : Link;
  const wrapperProps = external ? { href, target: "_blank", rel: "noopener noreferrer" } : { href };

  return (
    <motion.div
      variants={item}
      whileHover={{ borderColor: "rgba(0,120,212,0.5)" }}
      transition={{ duration: 0.2 }}
      className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-3 md:p-4 flex flex-col active:scale-95 touch-manipulation"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[rgba(0,120,212,0.1)] border border-[rgba(0,120,212,0.2)]">
          <Icon className="w-4 h-4 text-[#0078D4]" />
        </div>
        <StatusDot status={cardStatus} />
      </div>
      <h4 className="text-sm font-semibold text-[#f2f2f2]">{name}</h4>
      <p className="text-xs text-[#666] mt-0.5 mb-3 flex-1">{description}</p>
      {/* @ts-ignore - polymorphic link/anchor props differ */}
      <Wrapper {...wrapperProps} className="text-xs text-[#0078D4] hover:text-[#1a86d9] flex items-center gap-1 transition-colors w-fit">
        Open {external ? <ExternalLink className="w-3 h-3" /> : <ArrowRight className="w-3 h-3" />}
      </Wrapper>
    </motion.div>
  );
}

export default function DashboardPage() {
  const { data: apps, isLoading, refetch } = useArgoApps();
  const { isAdmin } = useRBAC();
  const qc = useQueryClient();
  const [syncAllLoading, setSyncAllLoading] = useState(false);
  const platformApps = usePlatformApps();

  const { data: healthData } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("fail");
      return res.json() as Promise<{ endpoints?: Array<{ name: string; results?: Array<{ success: boolean }> }> }>;
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

  const endpoints = healthData?.endpoints ?? [];

  const stats = useMemo(() => {
    if (!apps) return { total: 0, healthy: 0, synced: 0, degraded: 0 };
    return {
      total: apps.length,
      healthy: apps.filter(a => a.status.health.status === "Healthy").length,
      synced: apps.filter(a => a.status.sync.status === "Synced").length,
      degraded: apps.filter(a => a.status.health.status === "Degraded").length,
    };
  }, [apps]);

  const podStats = useMemo(() => {
    const pods = podsData ?? [];
    return {
      running: pods.filter(p => p.status === "Running").length,
      total: pods.length,
    };
  }, [podsData]);

  const gatusStats = useMemo(() => {
    const up = endpoints.filter(ep => ep.results?.[0]?.success === true).length;
    return { up, total: endpoints.length };
  }, [endpoints]);

  const recentActivity = useMemo(() => {
    if (!apps) return [];
    const sorted = [...apps].sort((a, b) => {
      const aTime = a.status.operationState?.finishedAt ? new Date(a.status.operationState.finishedAt).getTime() : 0;
      const bTime = b.status.operationState?.finishedAt ? new Date(b.status.operationState.finishedAt).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      const priority = (s: string) => s === "Degraded" ? 2 : s === "Progressing" ? 1 : 0;
      return priority(b.status.health.status) - priority(a.status.health.status);
    });
    return sorted.slice(0, 5);
  }, [apps]);

  const chartData = [
    { name: "Healthy", value: stats.healthy, color: "#22c55e" },
    { name: "Degraded", value: stats.degraded, color: "#ef4444" },
    { name: "Other", value: stats.total - stats.healthy - stats.degraded, color: "#64748b" },
  ].filter(d => d.value > 0);

  const handleSyncAll = async () => {
    if (!isAdmin) {
      toast.error("Admin permission required");
      return;
    }
    setSyncAllLoading(true);
    try {
      const res = await fetch("/api/argocd/sync-all", { method: "POST" });
      const data = await res.json() as { synced?: string[]; errors?: string[]; total?: number };
      if (data.total === 0) {
        toast.info("All apps already in sync");
      } else {
        toast.success(`Synced ${data.synced?.length ?? 0} app(s)${data.errors?.length ? `, ${data.errors.length} error(s)` : ""}`);
      }
      qc.invalidateQueries({ queryKey: ["argocd", "apps"] });
    } catch {
      toast.error("Sync all failed");
    } finally {
      setSyncAllLoading(false);
    }
  };

  return (
    <div>
      <PageHeader icon={LayoutDashboard} title="Dashboard" subtitle="Cluster overview and real-time metrics" />
      {/* Connection status row */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <ConnectionPill label="ArgoCD" url="/api/argocd/apps" />
        <ConnectionPill label="GitHub" url="/api/config/platform" />
        <ConnectionPill label="Health API" url="/api/health" />
      </div>

      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h2 className="flex flex-wrap items-center gap-3 text-xl font-bold text-[#f2f2f2]">
            Platform Overview
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-xs font-semibold text-green-400 uppercase tracking-wider">
              <span className="live-dot w-1.5 h-1.5 rounded-full bg-green-400" />
              Live
            </span>
          </h2>
          <p className="text-sm text-[#9e9e9e] mt-0.5">InfraWeaver homelab cluster status</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {isAdmin && (
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleSyncAll}
              disabled={syncAllLoading}
              className="flex min-h-[40px] items-center gap-2 rounded-lg border border-[rgba(0,120,212,0.2)] bg-[rgba(0,120,212,0.1)] px-3 py-2 text-sm text-[#0078D4] transition-colors hover:bg-[rgba(0,120,212,0.2)] disabled:opacity-50"
            >
              {syncAllLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Sync All
            </motion.button>
          )}
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={() => refetch()}
            className="flex min-h-[40px] items-center gap-2 rounded-lg border border-[#333] bg-[#2a2a2a] px-3 py-2 text-sm text-[#9e9e9e] transition-colors hover:bg-[#333] hover:text-[#f2f2f2]"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </motion.button>
        </div>
      </div>

      {/* Section 1: ArgoCD stat cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 rounded-xl shimmer" />
          ))}
        </div>
      ) : (
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8"
        >
          <StatCard title="Total Apps" value={stats.total} icon={Box} color="bg-indigo-500/20 text-indigo-400" subtitle="ArgoCD applications" />
          <StatCard title="Healthy" value={stats.healthy} icon={CheckCircle2} color="bg-green-500/20 text-green-400" subtitle={`${stats.total ? Math.round(stats.healthy/stats.total*100) : 0}% of total`} />
          <StatCard title="Synced" value={stats.synced} icon={RefreshCw} color="bg-blue-500/20 text-blue-400" subtitle="Git in sync" />
          <StatCard title="Degraded" value={stats.degraded} icon={AlertTriangle} color="bg-red-500/20 text-red-400" subtitle={stats.degraded > 0 ? "Needs attention" : "All good"} />
        </motion.div>
      )}

      {/* Section 2: Charts + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-5"
        >
          <h3 className="text-sm font-semibold text-[#f2f2f2] mb-4">Health Distribution</h3>
          {chartData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={chartData} cx="50%" cy="50%" innerRadius={50} outerRadius={75} paddingAngle={3} dataKey="value">
                    {chartData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 8, color: "#fff", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex gap-4 justify-center mt-3 flex-wrap">
                {chartData.map(d => (
                  <div key={d.name} className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                    <span className="text-xs text-[#9e9e9e]">{d.name}: <span className="text-[#f2f2f2] font-medium">{d.value}</span></span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No data</div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="lg:col-span-2 bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-5"
        >
          <h3 className="text-sm font-semibold text-[#f2f2f2] mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#9e9e9e]" />
            Recent Activity
          </h3>
          <div className="space-y-1">
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <div key={i} className="h-10 rounded-lg shimmer" />
              ))
            ) : recentActivity.map(app => (
              <motion.div
                key={app.metadata.name}
                whileHover={{ x: 2 }}
                className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-[#2a2a2a] transition-colors min-h-[44px] active:scale-95 touch-manipulation cursor-default"
              >
                <span className="text-sm text-[#f2f2f2] font-medium truncate">{app.metadata.name}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    app.status.health.status === "Healthy" ? "bg-green-500/15 text-green-400" :
                    app.status.health.status === "Degraded" ? "bg-red-500/15 text-red-400" :
                    app.status.health.status === "Progressing" ? "bg-yellow-500/15 text-yellow-400" :
                    "bg-slate-500/15 text-slate-400"
                  }`}>
                    {app.status.health.status}
                  </span>
                  {app.status.operationState?.finishedAt && (
                    <span className="text-xs text-[#666] hidden sm:block">
                      {timeAgo(app.status.operationState.finishedAt)}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </div>

      {/* Section 3: Namespace Usage */}
      <div className="mb-8">
        <NamespaceUsage />
      </div>

      {/* Section 4: Platform Services */}
      <div className="mb-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[#f2f2f2] flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#9e9e9e]" />
            Platform Services
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#666]">
            {gatusStats.total > 0 && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                {gatusStats.up}/{gatusStats.total} up
              </span>
            )}
            {podStats.total > 0 && (
              <span className="flex items-center gap-1">
                <Container className="w-3 h-3" />
                {podStats.running}/{podStats.total} pods
              </span>
            )}
          </div>
        </div>

        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
        >
          <ServiceCard
            name="Gatus"
            description="Endpoint monitoring & uptime tracking"
            href="/health"
            icon={Activity}
            enabled={platformApps.gatus}
            status={resolveStatus("gatus", endpoints)}
          />
          <ServiceCard
            name="Longhorn"
            description="Distributed block storage for Kubernetes"
            href="/storage"
            icon={HardDrive}
            enabled={platformApps.longhorn}
            status={resolveStatus("longhorn", endpoints)}
          />
          <ServiceCard
            name="NetBird"
            description="WireGuard-based overlay network & VPN"
            href="/network"
            icon={Network}
            enabled={platformApps.netbird}
            status={resolveStatus("netbird", endpoints)}
          />
          <ServiceCard
            name="OpenBao"
            description="Secrets management & encryption service"
            href="/security"
            icon={Shield}
            enabled={platformApps.openbao}
            status={resolveStatus("openbao", endpoints)}
          />
          <ServiceCard
            name="Authentik"
            description="Identity provider & SSO gateway"
            href="/security"
            icon={Users}
            enabled={platformApps.authentik}
            status={resolveStatus("authentik", endpoints)}
          />
          <ServiceCard
            name="Grafana"
            description="Metrics visualisation & dashboards"
            href="/health"
            icon={BarChart3}
            enabled={platformApps.grafana}
            status={resolveStatus("grafana", endpoints)}
          />
          <ServiceCard
            name="Wiki"
            description="Internal knowledge base"
            href="/health"
            icon={BookOpen}
            enabled={platformApps.wiki}
            status={resolveStatus("wiki", endpoints)}
          />
          <ServiceCard
            name="Registry"
            description="Container image registry"
            href="/registry"
            icon={Package}
            enabled={platformApps.registry}
            status={resolveStatus("registry", endpoints)}
          />
        </motion.div>
      </div>

      {/* Quick Actions */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5 }}
        className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-4"
      >
        <h3 className="text-xs font-semibold text-[#9e9e9e] uppercase tracking-wider mb-3">Quick Actions</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleSyncAll}
              disabled={syncAllLoading}
              className="flex min-h-[40px] items-center gap-2 rounded-lg border border-[rgba(0,120,212,0.2)] bg-[rgba(0,120,212,0.1)] px-3 py-2 text-sm text-[#0078D4] transition-colors hover:bg-[rgba(0,120,212,0.2)] disabled:opacity-50"
            >
              {syncAllLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Sync All Apps
            </motion.button>
          )}
          <Link
            href="/events"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#2a2a2a] border border-[#333] text-sm text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#333] transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            View Events
          </Link>
          {isAdmin && (
            <Link
              href="/security"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#2a2a2a] border border-[#333] text-sm text-[#9e9e9e] hover:text-[#f2f2f2] hover:bg-[#333] transition-colors"
            >
              <Shield className="w-3.5 h-3.5" />
              Security Overview
            </Link>
          )}
        </div>
      </motion.div>
    </div>
  );
}
