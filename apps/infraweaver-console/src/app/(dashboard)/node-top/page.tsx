"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { Activity, Search, X, Download, RefreshCw, ArrowUpDown, ArrowUp, ArrowDown, Cpu} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";

interface ContainerMetric {
  name: string;
  cpu_m: number;
  memory_mi: number;
  cpu_limit_m: number;
  memory_limit_mi: number;
}

interface PodMetric {
  namespace: string;
  name: string;
  containers: ContainerMetric[];
}

interface FlatRow {
  namespace: string;
  pod: string;
  container: string;
  cpu_m: number;
  memory_mi: number;
  cpu_limit_m: number;
  memory_limit_mi: number;
  cpuPct: number;
  memPct: number;
}

type SortKey = "namespace" | "pod" | "cpu_m" | "memory_mi" | "cpuPct" | "memPct";

function rowColor(cpuPct: number, memPct: number): string {
  const max = Math.max(cpuPct, memPct);
  if (max >= 90) return "bg-red-500/10 border-red-500/20";
  if (max >= 70) return "bg-amber-500/10 border-amber-500/20";
  return "bg-white/5 border-white/10";
}

function exportCSV(rows: FlatRow[]) {
  const header = "Namespace,Pod,Container,CPU (m),CPU Limit (m),CPU %,Memory (Mi),Mem Limit (Mi),Mem %\n";
  const lines = rows.map(r =>
    `${r.namespace},${r.pod},${r.container},${r.cpu_m},${r.cpu_limit_m},${r.cpuPct},${r.memory_mi},${r.memory_limit_mi},${r.memPct}`
  ).join("\n");
  const blob = new Blob([header + lines], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `node-top-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function NodeTopPage() {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("cpu_m");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery<{ pods: PodMetric[] }>({
    queryKey: ["cluster", "pod-metrics"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/pod-metrics");
      return res.json();
    },
    refetchInterval: 10_000,
    staleTime: 8_000,
  });

  const rows: FlatRow[] = useMemo(() => {
    const result: FlatRow[] = [];
    for (const pod of data?.pods ?? []) {
      for (const c of pod.containers) {
        const cpuPct = c.cpu_limit_m > 0 ? Math.round((c.cpu_m / c.cpu_limit_m) * 100) : 0;
        const memPct = c.memory_limit_mi > 0 ? Math.round((c.memory_mi / c.memory_limit_mi) * 100) : 0;
        result.push({ namespace: pod.namespace, pod: pod.name, container: c.name, cpu_m: c.cpu_m, memory_mi: c.memory_mi, cpu_limit_m: c.cpu_limit_m, memory_limit_mi: c.memory_limit_mi, cpuPct, memPct });
      }
    }
    return result;
  }, [data]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter(r => !q || r.namespace.includes(q) || r.pod.includes(q) || r.container.includes(q));
  }, [rows, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const va = a[sortKey] as string | number;
      const vb = b[sortKey] as string | number;
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 ml-1 text-slate-600" />;
    return sortDir === "asc" ? <ArrowUp className="w-3 h-3 ml-1 text-indigo-400" /> : <ArrowDown className="w-3 h-3 ml-1 text-indigo-400" />;
  }

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "—";

  return (
    <div>
      <PageHeader icon={Cpu} title="Node Metrics" />
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-cluster pointer-events-none" />
        <div className="relative flex items-start justify-between p-5 gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
              <Activity className="w-5 h-5 text-emerald-400" />
              Node Top — Pod Resource Usage
            </h2>
            <p className="text-sm text-slate-400 mt-0.5">Live pod CPU & memory from metrics-server · auto-refreshes every 10s · last: {lastUpdated}</p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/cluster" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors">
              ← Cluster
            </Link>
            <button onClick={() => exportCSV(sorted)} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors active:scale-95">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </button>
            <button onClick={() => { void refetch(); }} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors active:scale-95">
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by namespace, pod or container..."
          className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-9 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 transition-colors"
        />
        {search && (
          <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(8)].map((_, i) => <div key={i} className="h-10 rounded-lg bg-white/5 animate-pulse" />)}</div>
      ) : (
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="grid grid-cols-[2fr_3fr_2fr_1fr_1fr_1fr_1fr] gap-2 px-4 py-2.5 border-b border-white/10 text-xs font-semibold text-slate-500 uppercase tracking-wider">
            <button className="flex items-center hover:text-white transition-colors text-left" onClick={() => toggleSort("namespace")}>Namespace <SortIcon k="namespace" /></button>
            <button className="flex items-center hover:text-white transition-colors text-left" onClick={() => toggleSort("pod")}>Pod <SortIcon k="pod" /></button>
            <span>Container</span>
            <button className="flex items-center hover:text-white transition-colors justify-end" onClick={() => toggleSort("cpu_m")}>CPU (m) <SortIcon k="cpu_m" /></button>
            <button className="flex items-center hover:text-white transition-colors justify-end" onClick={() => toggleSort("cpuPct")}>CPU% <SortIcon k="cpuPct" /></button>
            <button className="flex items-center hover:text-white transition-colors justify-end" onClick={() => toggleSort("memory_mi")}>Mem (Mi) <SortIcon k="memory_mi" /></button>
            <button className="flex items-center hover:text-white transition-colors justify-end" onClick={() => toggleSort("memPct")}>Mem% <SortIcon k="memPct" /></button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {sorted.map((row, i) => (
              <motion.div
                key={`${row.namespace}-${row.pod}-${row.container}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className={cn("grid grid-cols-[2fr_3fr_2fr_1fr_1fr_1fr_1fr] gap-2 px-4 py-2.5 border-b border-white/5 text-xs hover:bg-white/5 transition-colors", rowColor(row.cpuPct, row.memPct))}
              >
                <span className="text-slate-400 truncate">{row.namespace}</span>
                <span className="text-white font-mono truncate">{row.pod}</span>
                <span className="text-slate-300 truncate">{row.container}</span>
                <span className="text-slate-300 text-right tabular-nums">{row.cpu_m}</span>
                <span className={cn("text-right tabular-nums font-semibold", row.cpuPct >= 90 ? "text-red-400" : row.cpuPct >= 70 ? "text-amber-400" : "text-emerald-400")}>
                  {row.cpu_limit_m > 0 ? `${row.cpuPct}%` : "—"}
                </span>
                <span className="text-slate-300 text-right tabular-nums">{row.memory_mi}</span>
                <span className={cn("text-right tabular-nums font-semibold", row.memPct >= 90 ? "text-red-400" : row.memPct >= 70 ? "text-amber-400" : "text-emerald-400")}>
                  {row.memory_limit_mi > 0 ? `${row.memPct}%` : "—"}
                </span>
              </motion.div>
            ))}
            {sorted.length === 0 && (
              <div className="py-12 text-center text-slate-500 text-sm">No pods match your filter</div>
            )}
          </div>
          <div className="px-4 py-2.5 border-t border-white/10 text-xs text-slate-500">
            {sorted.length} container{sorted.length !== 1 ? "s" : ""} {search ? `(filtered from ${rows.length})` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
