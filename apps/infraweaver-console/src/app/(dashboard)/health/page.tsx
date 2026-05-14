"use client";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, RefreshCw, ChevronDown, ChevronUp, Shield, Activity, Search } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { useState, useCallback } from "react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { HealthTimeline } from "@/components/ui/health-timeline";
import { RefreshCountdown } from "@/components/ui/refresh-countdown";

interface EndpointResult {
  success: boolean;
  duration: number;
  timestamp?: string;
}

interface Endpoint {
  name: string;
  results?: EndpointResult[];
}

function UptimeDots({ results }: { results: EndpointResult[] }) {
  const last7 = results.slice(0, 7).reverse();
  return (
    <div className="flex gap-1">
      {last7.map((r, i) => (
        <div
          key={i}
          className={cn("w-3 h-3 rounded-full flex-shrink-0", r.success ? "bg-green-500/80" : "bg-red-500/80")}
          title={r.timestamp}
        />
      ))}
    </div>
  );
}

function uptimePercent(results: EndpointResult[]): number {
  if (!results.length) return 0;
  const ok = results.filter(r => r.success).length;
  return Math.round((ok / results.length) * 100);
}

function groupByCategory(endpoints: Endpoint[]): Map<string, Endpoint[]> {
  const map = new Map<string, Endpoint[]>();
  for (const ep of endpoints) {
    const parts = ep.name.split(" > ");
    const category = parts.length > 1 ? parts[0] : "General";
    if (!map.has(category)) map.set(category, []);
    map.get(category)!.push(ep);
  }
  return map;
}

function displayName(name: string): string {
  const parts = name.split(" > ");
  return parts[parts.length - 1];
}

function HealthCard({ endpoint }: { endpoint: Endpoint }) {
  const [expanded, setExpanded] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const isUp = endpoint.results?.[0]?.success ?? false;
  const uptime = uptimePercent(endpoint.results ?? []);
  const last5 = (endpoint.results ?? []).slice(0, 5);
  const HISTORY_PAGE_SIZE = 3;
  const displayHistory = showAllHistory ? last5 : last5.slice(0, HISTORY_PAGE_SIZE);

  return (
    <motion.div
      layout
      whileHover={{ scale: expanded ? 1 : 1.01 }}
      className={cn(
        "border rounded-xl p-3 md:p-4 transition-colors cursor-pointer touch-manipulation active:scale-95",
        isUp
          ? "bg-green-500/5 border-green-500/20 hover:bg-green-500/8"
          : "bg-red-500/5 border-red-500/20 hover:bg-red-500/8"
      )}
      onClick={() => setExpanded(e => !e)}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-white truncate pr-2">{displayName(endpoint.name)}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isUp ? (
            <CheckCircle2 className="w-4 h-4 text-green-400" />
          ) : (
            <XCircle className="w-4 h-4 text-red-400" />
          )}
          {(endpoint.results?.length ?? 0) > 0 && (
            expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />
          )}
        </div>
      </div>
      {(endpoint.results?.length ?? 0) > 0 && (
        <>
          <UptimeDots results={endpoint.results!} />
          <div className="flex items-center justify-between mt-3">
            <span className={cn("text-xs font-semibold", isUp ? "text-green-400" : "text-red-400")}>
              {isUp ? "UP" : "DOWN"}
            </span>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              <span>{uptime}% uptime</span>
              {endpoint.results![0] && (
                <span>{endpoint.results![0].duration}ms</span>
              )}
            </div>
          </div>
          {/* Uptime bar */}
          <div className="mt-2 h-1 rounded-full bg-white/5 overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", uptime >= 99 ? "bg-green-500" : uptime >= 90 ? "bg-yellow-500" : "bg-red-500")}
              style={{ width: `${uptime}%` }}
            />
          </div>

          {/* Expanded: history entries, collapsed after 3 */}
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Last {last5.length} checks</p>
                  {displayHistory.map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <div className={cn("w-1.5 h-1.5 rounded-full", r.success ? "bg-green-400" : "bg-red-400")} />
                        <span className={r.success ? "text-green-400" : "text-red-400"}>{r.success ? "Success" : "Failed"}</span>
                      </div>
                      <div className="flex items-center gap-3 text-slate-500">
                        <span>{r.duration}ms</span>
                        {r.timestamp && <span>{timeAgo(r.timestamp)}</span>}
                      </div>
                    </div>
                  ))}
                  {last5.length > HISTORY_PAGE_SIZE && (
                    <button
                      onClick={e => { e.stopPropagation(); setShowAllHistory(v => !v); }}
                      className="w-full text-xs text-slate-500 hover:text-slate-300 pt-1 transition-colors"
                    >
                      {showAllHistory ? "Show fewer" : `+${last5.length - HISTORY_PAGE_SIZE} more`}
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </motion.div>
  );
}

interface SLAEntry {
  name: string;
  uptime24h: number;
  uptime7d: number;
  uptime30d: number;
}

interface SLAData {
  sla: SLAEntry[];
  overall: { uptime24h: number; uptime7d: number; uptime30d: number };
}

function UptimeBadge({ pct }: { pct: number }) {
  const color = pct >= 99.9 ? "text-emerald-400 bg-emerald-500/10" : pct >= 99 ? "text-amber-400 bg-amber-500/10" : "text-red-400 bg-red-500/10";
  return <span className={cn("px-2 py-0.5 rounded text-xs font-mono font-semibold tabular-nums", color)}>{pct.toFixed(2)}%</span>;
}

function SLASection({ data }: { data: SLAData }) {
  return (
    <CollapsibleSection title="SLA / Uptime" storageKey="health-sla" badge={<Shield className="w-4 h-4 text-emerald-400 flex-shrink-0" />}>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "24h Overall", value: data.overall.uptime24h },
          { label: "7d Overall", value: data.overall.uptime7d },
          { label: "30d Overall", value: data.overall.uptime30d },
        ].map(({ label, value }) => (
          <div key={label} className="bg-white/5 border border-white/10 rounded-xl p-3 text-center">
            <p className="text-xs text-slate-400 mb-1">{label}</p>
            <UptimeBadge pct={value} />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {data.sla.map(entry => (
          <div key={entry.name} className="flex items-center gap-3 p-3 rounded-lg bg-white/5 border border-white/10 flex-wrap">
            <span className="text-sm font-medium text-white flex-1 min-w-0 truncate">{entry.name}</span>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="hidden sm:inline">24h</span><UptimeBadge pct={entry.uptime24h} />
              <span className="hidden sm:inline">7d</span><UptimeBadge pct={entry.uptime7d} />
              <span className="hidden sm:inline">30d</span><UptimeBadge pct={entry.uptime30d} />
            </div>
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

export default function HealthPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "up" | "down">("all");
  const { data: health, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("Failed to fetch health");
      return res.json() as Promise<{ endpoints?: Endpoint[] }>;
    },
    refetchInterval: 30000,
  });

  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [pullY, setPullY] = useState(0);

  const { data: slaData } = useQuery<SLAData>({
    queryKey: ["health", "sla"],
    queryFn: async () => {
      const res = await fetch("/api/health/sla");
      return res.json();
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  const { data: timelineData } = useQuery({
    queryKey: ["health", "timeline"],
    queryFn: async () => {
      const res = await fetch("/api/health/timeline");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ data: { timestamp: string; status: string; latencyMs: number }[] }>;
    },
    staleTime: 60000,
  });

  const handlePullRefresh = useCallback(async () => {
    if (pullRefreshing) return;
    setPullRefreshing(true);
    await refetch();
    setPullRefreshing(false);
    setPullY(0);
  }, [pullRefreshing, refetch]);

  const filteredEndpoints = (health?.endpoints ?? []).filter((endpoint) => {
    const name = endpoint.name.toLowerCase();
    const isUp = endpoint.results?.[0]?.success === true;
    const matchesSearch = !search || name.includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || (statusFilter === "up" ? isUp : !isUp);
    return matchesSearch && matchesStatus;
  });
  const grouped = filteredEndpoints.length ? groupByCategory(filteredEndpoints) : new Map<string, Endpoint[]>();
  const allEndpoints = health?.endpoints ?? [];
  const upCount = allEndpoints.filter(ep => ep.results?.[0]?.success === true).length;
  const downCount = allEndpoints.filter(ep => ep.results?.[0]?.success === false).length;
  const unknownCount = allEndpoints.filter(ep => !ep.results?.length).length;
  const totalCount = allEndpoints.length;
  const lastChecked = dataUpdatedAt ? timeAgo(new Date(dataUpdatedAt).toISOString()) : "—";

  return (
    <div className="relative">
      <PageHeader icon={Activity} title="Health" subtitle="Cluster and service health overview" />
      {/* Pull-to-refresh indicator */}
      <motion.div
        drag="y"
        dragConstraints={{ top: 0, bottom: 80 }}
        dragElastic={0.3}
        onDrag={(_, info) => setPullY(Math.max(0, info.offset.y))}
        onDragEnd={(_, info) => {
          if (info.offset.y > 60) handlePullRefresh();
          else setPullY(0);
        }}
        style={{ y: 0 }}
        className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
      >
        <AnimatePresence>
          {pullY > 20 && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center justify-center py-2"
            >
              <RefreshCw className={cn("w-5 h-5 text-indigo-400", pullRefreshing && "animate-spin")} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Platform Health</h2>
          <p className="text-sm text-slate-400">Gatus endpoint monitoring status</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshCountdown intervalSeconds={30} resetKey={dataUpdatedAt} />
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors touch-manipulation active:scale-95"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search endpoints..."
            className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50"
          />
        </div>
        {(["all", "up", "down"] as const).map((value) => (
          <button
            key={value}
            onClick={() => setStatusFilter(value)}
            className={cn("rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors", statusFilter === value ? "border-indigo-500/40 bg-indigo-500/15 text-indigo-300" : "border-white/10 bg-white/5 text-slate-400 hover:text-white")}
          >
            {value}
          </button>
        ))}
      </div>

      {/* Summary stats bar */}
      {!isLoading && totalCount > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 flex-wrap mb-6 p-3 rounded-xl bg-white/5 border border-white/10"
        >
          <span className="text-xs text-slate-400 font-medium">
            {upCount}/{totalCount} services healthy
          </span>
          <div className="h-3 w-px bg-white/10" />
          <span className="flex items-center gap-1.5 text-xs">
            <span className="px-1.5 py-0.5 rounded-md bg-green-500/15 text-green-400 font-semibold">{upCount} up</span>
          </span>
          {downCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="px-1.5 py-0.5 rounded-md bg-red-500/15 text-red-400 font-semibold">{downCount} down</span>
            </span>
          )}
          {unknownCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="px-1.5 py-0.5 rounded-md bg-slate-500/15 text-slate-400 font-semibold">{unknownCount} unknown</span>
            </span>
          )}
          <div className="h-3 w-px bg-white/10" />
          <span className="text-xs text-slate-500">Last checked: {lastChecked}</span>
        </motion.div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-28 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {slaData && <SLASection data={slaData} />}
          {Array.from(grouped.entries()).map(([category, endpoints]) => (
            <CollapsibleSection
              key={category}
              title={category}
              count={endpoints.length}
              storageKey={`health-${category.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {endpoints.map((endpoint) => (
                  <HealthCard key={endpoint.name} endpoint={endpoint} />
                ))}
              </div>
            </CollapsibleSection>
          ))}
          {grouped.size === 0 && (
            <div className="py-16 text-center text-slate-500">
              <p className="text-sm">No endpoint data available</p>
            </div>
          )}
          {timelineData && timelineData.data.length > 0 && (
            <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 mt-4">
              <h3 className="text-sm font-semibold text-white mb-3">Service Uptime Timeline</h3>
              <HealthTimeline data={timelineData.data} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
