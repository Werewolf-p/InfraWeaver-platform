"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

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

export default function HealthPage() {
  const { data: health, isLoading, refetch } = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("Failed to fetch health");
      return res.json() as Promise<{ endpoints?: Endpoint[] }>;
    },
    refetchInterval: 30000,
  });

  const grouped = health?.endpoints ? groupByCategory(health.endpoints) : new Map<string, Endpoint[]>();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Platform Health</h2>
          <p className="text-sm text-slate-400">Gatus endpoint monitoring status</p>
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(8)].map((_, i) => <div key={i} className="h-28 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([category, endpoints]) => (
            <div key={category}>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">{category}</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {endpoints.map((endpoint) => {
                  const isUp = endpoint.results?.[0]?.success ?? false;
                  const uptime = uptimePercent(endpoint.results ?? []);
                  return (
                    <motion.div
                      key={endpoint.name}
                      whileHover={{ scale: 1.01 }}
                      className={cn(
                        "bg-white/5 border rounded-xl p-4",
                        isUp ? "border-green-500/20" : "border-red-500/20"
                      )}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-white truncate pr-2">{displayName(endpoint.name)}</span>
                        {isUp ? (
                          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        )}
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
                        </>
                      )}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          ))}
          {grouped.size === 0 && (
            <div className="py-16 text-center text-slate-500">
              <p className="text-sm">No endpoint data available</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
