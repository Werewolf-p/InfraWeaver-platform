"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Download, Trash2, Search, RefreshCw, AlertCircle } from "lucide-react";
import { usePods } from "@/hooks/use-pods";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export default function LogsPage() {
  const { can } = useRBAC();
  const { data: pods, isLoading: podsLoading } = usePods();

  const [selectedNamespace, setSelectedNamespace] = useState("");
  const [selectedPod, setSelectedPod] = useState("");
  const [selectedContainer, setSelectedContainer] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [error, setError] = useState("");
  const logsRef = useRef<HTMLDivElement>(null);

  const namespaces = [...new Set((pods ?? []).map(p => p.namespace))].sort();
  const namespacePods = (pods ?? []).filter(p => p.namespace === selectedNamespace);
  const podContainers = (pods ?? []).find(p => p.name === selectedPod)?.containers ?? [];

  const fetchLogs = useCallback(async () => {
    if (!selectedNamespace || !selectedPod || !selectedContainer) return;
    setLogsLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/logs/${encodeURIComponent(selectedNamespace)}/${encodeURIComponent(selectedPod)}/${encodeURIComponent(selectedContainer)}?lines=500`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      setLogs(text.split("\n").filter(Boolean));
    } catch (e) {
      setError(String(e));
    } finally {
      setLogsLoading(false);
    }
  }, [selectedNamespace, selectedPod, selectedContainer]);

  useEffect(() => {
    if (autoScroll && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const filteredLogs = filter ? logs.filter(l => l.toLowerCase().includes(filter.toLowerCase())) : logs;

  const handleDownload = () => {
    const blob = new Blob([filteredLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedPod}-${selectedContainer}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!can("apps:read")) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center">
        <AlertCircle className="w-8 h-8 text-red-400 mb-3" />
        <h3 className="text-white font-semibold mb-1">Access Denied</h3>
        <p className="text-slate-400 text-sm">You need apps:read permission to view logs.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-indigo-400" />
            Pod Logs
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Stream logs from any pod container</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Namespace</label>
          {podsLoading ? <Skeleton className="h-10" /> : (
            <select
              value={selectedNamespace}
              onChange={e => { setSelectedNamespace(e.target.value); setSelectedPod(""); setSelectedContainer(""); setLogs([]); }}
              className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50"
            >
              <option value="">Select namespace...</option>
              {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
            </select>
          )}
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Pod</label>
          <select
            value={selectedPod}
            onChange={e => { setSelectedPod(e.target.value); setSelectedContainer(""); setLogs([]); }}
            disabled={!selectedNamespace}
            className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
          >
            <option value="">Select pod...</option>
            {namespacePods.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Container</label>
          <select
            value={selectedContainer}
            onChange={e => { setSelectedContainer(e.target.value); setLogs([]); }}
            disabled={!selectedPod}
            className="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
          >
            <option value="">Select container...</option>
            {podContainers.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        <button
          onClick={fetchLogs}
          disabled={!selectedContainer || logsLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50 flex-shrink-0"
        >
          <RefreshCw className={cn("w-4 h-4", logsLoading && "animate-spin")} />
          {logsLoading ? "Loading…" : "Load Logs"}
        </button>
        <div className="relative flex-1 min-w-[140px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter logs…"
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer flex-shrink-0">
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} className="w-3.5 h-3.5 accent-indigo-500" />
          Auto-scroll
        </label>
        <span className="text-xs text-slate-500 flex-shrink-0">{filteredLogs.length} lines</span>
        {logs.length > 0 && (
          <>
            <button onClick={handleDownload} className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-400 hover:text-white transition-colors flex-shrink-0">
              <Download className="w-3.5 h-3.5" /> Download
            </button>
            <button onClick={() => setLogs([])} className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-400 hover:text-white transition-colors flex-shrink-0">
              <Trash2 className="w-3.5 h-3.5" /> Clear
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <div
        ref={logsRef}
        className="flex-1 min-h-[300px] max-h-[500px] md:max-h-[600px] overflow-y-auto bg-slate-950 border border-white/10 rounded-xl p-4 font-mono text-xs text-slate-300 leading-relaxed"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600">
            {selectedContainer ? "No logs loaded — click Load Logs" : "Select a namespace, pod, and container to view logs"}
          </div>
        ) : (
          filteredLogs.map((line, i) => (
            <div key={i} className={cn(
              "py-0.5 hover:bg-white/5 px-1 rounded",
              line.toLowerCase().includes("error") && "text-red-400",
              line.toLowerCase().includes("warn") && "text-yellow-400"
            )}>
              <span className="text-slate-600 select-none mr-3">{(i + 1).toString().padStart(4, " ")}</span>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
