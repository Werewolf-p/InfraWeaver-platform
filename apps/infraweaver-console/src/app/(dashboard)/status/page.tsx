"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ServiceStatus {
  name: string;
  status: string;
  latencyMs: number;
}

interface PlatformStatus {
  status: string;
  services: ServiceStatus[];
  metrics: { totalNodes: number; readyNodes: number; uptime: string };
  checkedAt: string;
}

function statusBanner(status: string) {
  if (status === "operational") return { bg: "bg-green-500/10 border-green-500/30", text: "text-green-400", label: "All Systems Operational" };
  if (status === "degraded") return { bg: "bg-yellow-500/10 border-yellow-500/30", text: "text-yellow-400", label: "Partial Outage" };
  return { bg: "bg-red-500/10 border-red-500/30", text: "text-red-400", label: "Major Outage" };
}

function serviceColor(status: string) {
  if (status === "operational") return "text-green-400 bg-green-500/10 border-green-500/20";
  if (status === "degraded") return "text-yellow-400 bg-yellow-500/10 border-yellow-500/20";
  return "text-red-400 bg-red-500/10 border-red-500/20";
}

export default function StatusPage() {
  const [countdown, setCountdown] = useState(30);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["platform", "status"],
    queryFn: async () => {
      const res = await fetch("/api/platform/status");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<PlatformStatus>;
    },
    refetchInterval: 30000,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { setCountdown(30); return 30; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const banner = statusBanner(data?.status ?? "operational");

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Activity className="w-5 h-5 text-slate-400" />Platform Status</h2>
          <p className="text-sm text-slate-400">Real-time system status · auto-refresh {countdown}s</p>
        </div>
        <button onClick={() => void refetch()} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />Refresh
        </button>
      </div>

      <div className={cn("rounded-2xl border p-8 text-center", banner.bg)}>
        <p className={cn("text-3xl font-bold", banner.text)}>{banner.label}</p>
        <p className="text-sm text-slate-400 mt-2">Last checked: {data?.checkedAt ? new Date(data.checkedAt).toLocaleTimeString() : "—"}</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Nodes", value: data?.metrics.totalNodes ?? 0, color: "text-white" },
          { label: "Ready Nodes", value: data?.metrics.readyNodes ?? 0, color: "text-green-400" },
          { label: "Uptime", value: data?.metrics.uptime ?? "—", color: "text-indigo-400" },
        ].map(m => (
          <div key={m.label} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-400">{m.label}</p>
            <p className={`text-3xl font-bold mt-1 ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
        <h3 className="text-sm font-semibold text-white mb-4">Services</h3>
        <div className="grid grid-cols-2 gap-3">
          {(data?.services ?? []).map(s => (
            <div key={s.name} className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/10">
              <span className="text-sm text-white">{s.name}</span>
              <div className="flex items-center gap-2">
                {s.latencyMs > 0 && <span className="text-xs text-slate-500">{s.latencyMs}ms</span>}
                <span className={cn("text-xs px-2 py-0.5 rounded-full border", serviceColor(s.status))}>{s.status}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
}
