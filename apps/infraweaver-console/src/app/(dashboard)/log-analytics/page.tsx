"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, BarChart2} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import { PageHeader } from "@/components/ui/page-header";

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

export default function LogAnalyticsPage() {
  const [selectedNs, setSelectedNs] = useState("default");
  const [selectedPod, setSelectedPod] = useState("");
  const [selectedContainer, setSelectedContainer] = useState("");
  const [analyze, setAnalyze] = useState(false);

  const { data: podsData } = useQuery({
    queryKey: ["pods"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Pod[]>;
    },
  });

  const { data: analytics, isLoading } = useQuery({
    queryKey: ["log-analytics", selectedNs, selectedPod, selectedContainer],
    queryFn: async () => {
      const res = await fetch(`/api/logs/analytics?namespace=${selectedNs}&pod=${selectedPod}&container=${selectedContainer}`);
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<AnalyticsData>;
    },
    enabled: analyze && !!selectedPod && !!selectedContainer,
  });

  const pods = podsData ?? [];
  const namespaces = [...new Set(pods.map(p => p.namespace))];
  const nsPods = pods.filter(p => p.namespace === selectedNs);
  const selectedPodObj = nsPods.find(p => p.name === selectedPod);

  const pieData = analytics ? Object.entries(analytics.levels).map(([name, value]) => ({ name, value })) : [];
  const barData = Object.entries(LEVEL_COLORS).map(([level]) => ({ level, count: analytics?.levels[level] ?? 0 }));

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={BarChart2} title="Log Analytics" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><FileText className="w-5 h-5 text-slate-400" />Log Analytics</h2>
        <p className="text-sm text-slate-400">Analyze log patterns and error distribution</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Namespace</label>
            <select value={selectedNs} onChange={e => { setSelectedNs(e.target.value); setSelectedPod(""); setSelectedContainer(""); setAnalyze(false); }} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
              {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Pod</label>
            <select value={selectedPod} onChange={e => { setSelectedPod(e.target.value); setSelectedContainer(""); setAnalyze(false); }} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
              <option value="">Select pod...</option>
              {nsPods.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Container</label>
            <select value={selectedContainer} onChange={e => { setSelectedContainer(e.target.value); setAnalyze(false); }} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50">
              <option value="">Select container...</option>
              {(selectedPodObj?.containers ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <button onClick={() => setAnalyze(true)} disabled={!selectedPod || !selectedContainer} className="w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
          Analyze Logs
        </button>
      </div>

      {analyze && isLoading && <div className="h-48 bg-white/5 rounded-xl animate-pulse" />}

      {analytics && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
              <h3 className="text-sm font-semibold text-white mb-3">Log Level Distribution</h3>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70}>
                    {pieData.map(entry => <Cell key={entry.name} fill={LEVEL_COLORS[entry.name as keyof typeof LEVEL_COLORS] ?? "#6366f1"} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
              <h3 className="text-sm font-semibold text-white mb-3">Counts by Level</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="level" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: "#1e293b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }} />
                  <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Top Errors ({analytics.topErrors.length})</h3>
            {analytics.topErrors.length === 0 ? (
              <p className="text-sm text-green-400">No errors found</p>
            ) : (
              <div className="space-y-2">
                {analytics.topErrors.map((err, i) => (
                  <div key={i} className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300 font-mono">{err}</div>
                ))}
              </div>
            )}
            <p className="text-xs text-slate-500 mt-3">Total lines analyzed: {analytics.totalLines}</p>
          </div>
        </>
      )}
    </motion.div>
  );
}
