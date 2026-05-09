"use client";
import { motion } from "framer-motion";
import { useArgoApps } from "@/hooks/use-argocd";
import { Box, CheckCircle2, AlertTriangle, RefreshCw, Zap, CheckCircle, XCircle, Loader2, Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};
const item = { hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } };

function StatCard({ title, value, icon: Icon, color, subtitle }: {
  title: string; value: number | string; icon: React.ElementType; color: string; subtitle?: string;
}) {
  return (
    <motion.div
      variants={item}
      whileHover={{ scale: 1.01, y: -2 }}
      className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-400 font-medium">{title}</span>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
          <Icon className="w-4 h-4" />
        </div>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
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
      isLoading ? "bg-slate-500/10 border-slate-500/20 text-slate-400"
        : isError ? "bg-red-500/10 border-red-500/20 text-red-400"
        : "bg-green-500/10 border-green-500/20 text-green-400"
    )}>
      {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : isError ? <XCircle className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
      {label}
    </div>
  );
}

export default function DashboardPage() {
  const { data: apps, isLoading, refetch } = useArgoApps();
  const { isAdmin } = useRBAC();
  const qc = useQueryClient();
  const [syncAllLoading, setSyncAllLoading] = useState(false);

  const stats = useMemo(() => {
    if (!apps) return { total: 0, healthy: 0, synced: 0, degraded: 0 };
    return {
      total: apps.length,
      healthy: apps.filter(a => a.status.health.status === "Healthy").length,
      synced: apps.filter(a => a.status.sync.status === "Synced").length,
      degraded: apps.filter(a => a.status.health.status === "Degraded").length,
    };
  }, [apps]);

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
      {/* Connection status row */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <ConnectionPill label="ArgoCD" url="/api/argocd/apps" />
        <ConnectionPill label="GitHub" url="/api/config/platform" />
        <ConnectionPill label="Health API" url="/api/health" />
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Platform Overview</h2>
          <p className="text-sm text-slate-400 mt-0.5">InfraWeaver homelab cluster status</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={handleSyncAll}
              disabled={syncAllLoading}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              {syncAllLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Sync All
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 rounded-xl bg-white/5 animate-pulse" />
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5"
        >
          <h3 className="text-sm font-semibold text-white mb-4">Health Distribution</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={chartData} cx="50%" cy="50%" innerRadius={55} outerRadius={80} paddingAngle={3} dataKey="value">
                  {chartData.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "#fff" }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-slate-500 text-sm">No data</div>
          )}
          <div className="flex gap-4 justify-center mt-2">
            {chartData.map(d => (
              <div key={d.name} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                <span className="text-xs text-slate-400">{d.name}: {d.value}</span>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="lg:col-span-2 bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-5"
        >
          <h3 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            Recent Activity
          </h3>
          <div className="space-y-2">
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <div key={i} className="h-10 rounded-lg bg-white/5 animate-pulse" />
              ))
            ) : recentActivity.map(app => (
              <div key={app.metadata.name} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/5 transition-colors">
                <span className="text-sm text-slate-200 font-medium">{app.metadata.name}</span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    app.status.health.status === "Healthy" ? "bg-green-500/15 text-green-400" :
                    app.status.health.status === "Degraded" ? "bg-red-500/15 text-red-400" :
                    app.status.health.status === "Progressing" ? "bg-yellow-500/15 text-yellow-400" :
                    "bg-slate-500/15 text-slate-400"
                  }`}>
                    {app.status.health.status}
                  </span>
                  {app.status.operationState?.finishedAt && (
                    <span className="text-xs text-slate-500">
                      {timeAgo(app.status.operationState.finishedAt)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
