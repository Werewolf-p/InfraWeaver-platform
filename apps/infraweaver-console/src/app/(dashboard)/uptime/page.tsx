"use client";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { TrendingUp, RefreshCw, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface GatusResult {
  success: boolean;
  duration: number;
  timestamp?: string;
}

interface GatusEndpoint {
  name: string;
  group?: string;
  results: GatusResult[];
}

interface HealthResponse {
  endpoints: GatusEndpoint[];
}

function uptimePercent(results: GatusResult[]) {
  if (!results.length) return 0;
  const ok = results.filter(r => r.success).length;
  return Math.round((ok / results.length) * 100);
}

function StatusBadge({ pct }: { pct: number }) {
  if (pct === 100) return <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 border border-green-500/30 text-green-400 font-medium">100% Up</span>;
  if (pct >= 90) return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 font-medium">{pct}% Up</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 font-medium">{pct}% Up</span>;
}

function CheckDot({ result }: { result: GatusResult }) {
  const color = result.success ? "bg-green-500" : "bg-red-500";
  const title = `${result.success ? "Up" : "Down"}${result.duration ? ` · ${result.duration}ms` : ""}${result.timestamp ? ` · ${new Date(result.timestamp).toLocaleString()}` : ""}`;
  return (
    <span
      title={title}
      className={cn("inline-block w-3.5 h-3.5 rounded-sm flex-shrink-0 cursor-default transition-transform hover:scale-125", color)}
    />
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 p-4 border-b border-white/5 last:border-0">
      <div className="w-5 h-4 rounded bg-white/10 animate-pulse" />
      <div className="w-36 h-4 rounded bg-white/10 animate-pulse" />
      <div className="flex-1 flex gap-0.5">
        {[...Array(30)].map((_, i) => (
          <div key={i} className="w-3.5 h-3.5 rounded-sm bg-white/10 animate-pulse" />
        ))}
      </div>
      <div className="w-16 h-5 rounded-full bg-white/10 animate-pulse" />
    </div>
  );
}

export default function UptimePage() {
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<HealthResponse>({
    queryKey: ["uptime-history"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("Failed to fetch health data");
      return res.json();
    },
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const endpoints = data?.endpoints ?? [];

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;

  const overallUptime = endpoints.length
    ? Math.round(endpoints.reduce((sum, ep) => sum + uptimePercent(ep.results), 0) / endpoints.length)
    : 0;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
      >
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <TrendingUp className="w-6 h-6 text-emerald-400" />
            Uptime History
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Last {endpoints[0]?.results.length ?? 0} checks per endpoint · via Gatus
          </p>
          <span className="inline-flex items-center gap-1 text-xs text-amber-400/70 mt-1">
            <AlertTriangle className="w-3 h-3" /> Simulated data — connect Gatus for live results
          </span>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-slate-500 flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> {lastUpdated}
            </span>
          )}
          <button
            onClick={() => refetch()}
            className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
          </button>
        </div>
      </motion.div>

      {/* Overall summary */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="grid grid-cols-3 gap-4"
      >
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-3xl font-bold text-white tabular-nums">{endpoints.length}</div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Endpoints</p>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className={cn(
            "text-3xl font-bold tabular-nums",
            overallUptime === 100 ? "text-emerald-400" : overallUptime >= 90 ? "text-yellow-400" : "text-red-400"
          )}>
            {overallUptime}%
          </div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Avg Uptime</p>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-3xl font-bold text-white tabular-nums">
            {endpoints.filter(ep => ep.results[0]?.success).length}
          </div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Currently Up</p>
        </div>
      </motion.div>

      {/* Legend */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="flex items-center gap-4 text-xs text-slate-500"
      >
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Online
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-red-500 inline-block" /> Offline
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-white/10 inline-block" /> No data
        </span>
        <span className="ml-auto">← Oldest · Newest →</span>
      </motion.div>

      {/* Endpoint rows */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="bg-white/5 border border-white/10 rounded-xl overflow-hidden"
      >
        {isLoading ? (
          [...Array(6)].map((_, i) => <SkeletonRow key={i} />)
        ) : endpoints.length === 0 ? (
          <div className="py-16 text-center">
            <AlertTriangle className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">No endpoint data available</p>
          </div>
        ) : (
          endpoints.map((ep, idx) => {
            const pct = uptimePercent(ep.results);
            const isUp = ep.results[0]?.success ?? false;
            const avgMs = ep.results.length
              ? Math.round(ep.results.reduce((s, r) => s + (r.duration ?? 0), 0) / ep.results.length)
              : 0;

            return (
              <motion.div
                key={ep.name}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.03 }}
                className="flex items-center gap-4 px-4 py-3.5 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors"
              >
                {/* Status icon */}
                <div className="w-5 flex-shrink-0">
                  {isUp ? (
                    <CheckCircle2 className="w-4 h-4 text-green-400" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-400" />
                  )}
                </div>

                {/* Name */}
                <div className="w-40 flex-shrink-0">
                  <p className="text-sm font-medium text-white truncate">{ep.name}</p>
                  {ep.group && <p className="text-xs text-slate-500">{ep.group}</p>}
                </div>

                {/* Check dots */}
                <div className="flex-1 flex items-center gap-0.5 overflow-hidden">
                  {ep.results.length > 0 ? (
                    ep.results.slice(-60).map((r, i) => (
                      <CheckDot key={i} result={r} />
                    ))
                  ) : (
                    [...Array(30)].map((_, i) => (
                      <span key={i} className="inline-block w-3.5 h-3.5 rounded-sm bg-white/10 flex-shrink-0" />
                    ))
                  )}
                </div>

                {/* Avg response */}
                {avgMs > 0 && (
                  <span className="text-xs text-slate-500 font-mono w-16 text-right flex-shrink-0">
                    {avgMs}ms avg
                  </span>
                )}

                {/* Uptime badge */}
                <div className="w-20 flex-shrink-0 flex justify-end">
                  <StatusBadge pct={pct} />
                </div>
              </motion.div>
            );
          })
        )}
      </motion.div>

      <p className="text-xs text-slate-600 text-center">
        Data sourced from Gatus ·{" "}
        <a href="https://status.rlservers.com" target="_blank" rel="noopener noreferrer" className="hover:text-slate-400 underline">
          status.rlservers.com
        </a>
      </p>
    </div>
  );
}
