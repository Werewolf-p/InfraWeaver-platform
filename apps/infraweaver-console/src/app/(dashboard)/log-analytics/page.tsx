"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight, BarChart2 } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { FilterSelect } from "@/components/ui/filter-select";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useApiQuery } from "@/hooks/use-api-query";

interface Pod {
  name: string;
  namespace: string;
  containers: string[];
  status: string;
}

interface AnalyticsData {
  levels: Record<string, number>;
  topErrors: string[];
  totalLines: number;
}

const LEVEL_COLORS = { error: "#ef4444", warn: "#f59e0b", info: "#6366f1", debug: "#64748b" };

const LOG_VIEWER_PREFERENCES_KEY = "infraweaver:log-viewer-preferences";

/** Seed the log viewer's persisted filter so the deep-link opens pre-filtered. */
function seedLogFilter(filter: string) {
  if (typeof window === "undefined") return;
  try {
    const prev = JSON.parse(localStorage.getItem(LOG_VIEWER_PREFERENCES_KEY) ?? "null") ?? {};
    localStorage.setItem(LOG_VIEWER_PREFERENCES_KEY, JSON.stringify({ ...prev, filter, regexMode: false }));
  } catch {
    // ignore persistence failures — the pod is still pre-selected via query params
  }
}

export default function LogAnalyticsPage() {
  const [selectedNs, setSelectedNs] = useState("default");
  const [selectedPod, setSelectedPod] = useState("");
  const [selectedContainer, setSelectedContainer] = useState("");
  const [analyze, setAnalyze] = useState(false);

  const { data: podsData } = useApiQuery<Pod[]>({
    queryKey: ["pods"],
    path: "/api/pods",
  });

  const { data: analytics, isLoading, isError, error } = useApiQuery<AnalyticsData>({
    queryKey: ["log-analytics", selectedNs, selectedPod, selectedContainer],
    path: "/api/logs/analytics",
    request: { query: { namespace: selectedNs, pod: selectedPod, container: selectedContainer } },
    enabled: analyze && !!selectedPod && !!selectedContainer,
  });

  const pods = podsData ?? [];
  const namespaces = [...new Set(pods.map(p => p.namespace))];
  const nsPods = pods.filter(p => p.namespace === selectedNs);
  const selectedPodObj = nsPods.find(p => p.name === selectedPod);

  const pieData = analytics ? Object.entries(analytics.levels).map(([name, value]) => ({ name, value })) : [];
  const hasLevels = pieData.some((entry) => entry.value > 0);

  const logsHref = `/logs?namespace=${encodeURIComponent(selectedNs)}&pod=${encodeURIComponent(selectedPod)}&container=${encodeURIComponent(selectedContainer)}`;

  return (
    <PageScaffold icon={BarChart2} title="Log Analytics" subtitle="Analyze log patterns and error distribution">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Namespace</label>
            <FilterSelect
              label="Namespace"
              className="w-full"
              value={selectedNs}
              onChange={(value) => { setSelectedNs(value); setSelectedPod(""); setSelectedContainer(""); setAnalyze(false); }}
              options={namespaces}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Pod</label>
            <FilterSelect
              label="Pod"
              className="w-full"
              value={selectedPod}
              onChange={(value) => { setSelectedPod(value); setSelectedContainer(""); setAnalyze(false); }}
              options={[{ value: "", label: "Select pod..." }, ...nsPods.map(p => p.name)]}
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Container</label>
            <FilterSelect
              label="Container"
              className="w-full"
              value={selectedContainer}
              onChange={(value) => { setSelectedContainer(value); setAnalyze(false); }}
              options={[{ value: "", label: "Select container..." }, ...(selectedPodObj?.containers ?? [])]}
            />
          </div>
        </div>
        <button onClick={() => setAnalyze(true)} disabled={!selectedPod || !selectedContainer} className="w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
          Analyze Logs
        </button>
      </div>

      {!analyze && (
        <div className="rounded-xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100/50 dark:bg-slate-900/40 p-8 text-center">
          <BarChart2 className="mx-auto mb-3 h-8 w-8 text-slate-400 dark:text-slate-600" />
          <p className="text-sm text-slate-500 dark:text-slate-400">Select a pod and container, then run <span className="font-medium text-gray-700 dark:text-slate-300">Analyze Logs</span> to see level distribution and the top recurring errors.</p>
        </div>
      )}

      {analyze && isLoading && <div className="h-48 bg-gray-100 dark:bg-white/5 rounded-xl animate-pulse" />}

      {analyze && isError && (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
          <div>
            <p className="text-sm font-semibold text-red-300">Failed to analyze logs</p>
            <p className="mt-1 text-xs text-red-300/80">{error instanceof Error ? error.message : "The analytics service did not return a result. Confirm the pod is running and try again."}</p>
            <button onClick={() => setAnalyze(false)} className="mt-2 text-xs text-red-200 underline hover:text-white">Reset selection</button>
          </div>
        </div>
      )}

      {analyze && !isLoading && !isError && analytics && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Log Level Distribution</h3>
            {hasLevels ? (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}>
                      {pieData.map(entry => <Cell key={entry.name} fill={LEVEL_COLORS[entry.name as keyof typeof LEVEL_COLORS] ?? "#6366f1"} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="mt-3 flex flex-wrap gap-2">
                  {pieData.filter((entry) => entry.value > 0).map((entry) => (
                    <span key={entry.name} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-white/10 bg-white/40 dark:bg-white/5 px-2 py-1 text-xs text-slate-600 dark:text-slate-300">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: LEVEL_COLORS[entry.name as keyof typeof LEVEL_COLORS] ?? "#6366f1" }} aria-hidden="true" />
                      {entry.name} <span className="font-semibold tabular-nums text-gray-900 dark:text-white">{entry.value}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="py-12 text-center text-sm text-slate-500">No level data in the sampled window.</p>
            )}
            <p className="text-xs text-slate-500 mt-3">Total lines analyzed: {analytics.totalLines}</p>
          </div>

          <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Top Errors ({analytics.topErrors.length})</h3>
            {analytics.topErrors.length === 0 ? (
              <p className="text-sm text-green-400">No errors found</p>
            ) : (
              <div className="space-y-2">
                {analytics.topErrors.map((err, i) => (
                  <Link
                    key={i}
                    href={logsHref}
                    onClick={() => seedLogFilter(err)}
                    className="group flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-mono text-red-300 transition-colors hover:border-red-500/40 hover:bg-red-500/15"
                    title="Open in Logs pre-filtered to this error"
                  >
                    <span className="min-w-0 flex-1 break-words">{err}</span>
                    <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-400/60 transition-colors group-hover:text-red-300" aria-hidden="true" />
                  </Link>
                ))}
                <p className="pt-1 text-[11px] text-slate-500">Click any error to open the Logs viewer filtered to that line.</p>
              </div>
            )}
          </div>
        </div>
      )}
      </motion.div>
    </PageScaffold>
  );
}
