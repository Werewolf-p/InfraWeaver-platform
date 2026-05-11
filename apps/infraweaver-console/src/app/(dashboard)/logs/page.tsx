"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Terminal, Download, Trash2, Search, RefreshCw, AlertCircle, Copy, Check, FileText } from "lucide-react";
import { usePods } from "@/hooks/use-pods";
import { useRBAC } from "@/hooks/use-rbac";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

type LogLevel = "ALL" | "ERROR" | "WARN" | "INFO";

function getLineLevel(line: string): LogLevel {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("fatal") || l.includes("critical")) return "ERROR";
  if (l.includes("warn") || l.includes("warning")) return "WARN";
  if (l.includes("info") || l.includes("debug")) return "INFO";
  return "ALL";
}

function CopyLineButton({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void navigator.clipboard.writeText(line); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0 text-white/30 hover:text-white/70"
      aria-label="Copy line"
    >
      {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

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
  const [levelFilter, setLevelFilter] = useState<LogLevel>("ALL");
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

  const filteredLogs = logs.filter(l => {
    const textMatch = !filter || l.toLowerCase().includes(filter.toLowerCase());
    const levelMatch = levelFilter === "ALL" || getLineLevel(l) === levelFilter;
    return textMatch && levelMatch;
  });

  const handleDownload = () => {
    const blob = new Blob([filteredLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${selectedPod}-${selectedContainer}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const levelCounts = {
    ERROR: logs.filter(l => getLineLevel(l) === "ERROR").length,
    WARN: logs.filter(l => getLineLevel(l) === "WARN").length,
    INFO: logs.filter(l => getLineLevel(l) === "INFO").length,
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
      <PageHeader icon={FileText} title="Pod Logs" subtitle="Live streaming pod logs" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Terminal className="w-5 h-5 text-indigo-400" />
            Pod Logs
          </h2>
          <p className="text-sm text-slate-400 mt-0.5">Stream logs from any pod container</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
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

      <div className="flex items-center gap-3 flex-wrap overflow-x-auto scrollbar-none">
        <button
          onClick={fetchLogs}
          disabled={!selectedContainer || logsLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50 flex-shrink-0"
        >
          <RefreshCw className={cn("w-4 h-4", logsLoading && "animate-spin")} />
          {logsLoading ? "Loading..." : "Load Logs"}
        </button>
        <div className="relative flex-1 min-w-[160px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter logs..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
          />
        </div>

        {/* Level filter buttons */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-white/5 border border-white/10 flex-shrink-0">
          {(["ALL", "ERROR", "WARN", "INFO"] as LogLevel[]).map(lvl => {
            const count = lvl === "ALL" ? logs.length : levelCounts[lvl];
            const styles: Record<LogLevel, string> = {
              ALL: "hover:text-white",
              ERROR: "hover:text-red-300",
              WARN: "hover:text-yellow-300",
              INFO: "hover:text-blue-300",
            };
            const activeStyles: Record<LogLevel, string> = {
              ALL: "bg-white/15 text-white",
              ERROR: "bg-red-500/20 text-red-300",
              WARN: "bg-yellow-500/20 text-yellow-300",
              INFO: "bg-blue-500/20 text-blue-300",
            };
            return (
              <button
                key={lvl}
                onClick={() => setLevelFilter(lvl)}
                className={cn(
                  "px-2 py-1 rounded-md text-xs font-medium transition-all",
                  levelFilter === lvl ? activeStyles[lvl] : `text-white/40 ${styles[lvl]}`
                )}
              >
                {lvl} {count > 0 && <span className="opacity-60">({count})</span>}
              </button>
            );
          })}
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
        className="flex-1 min-h-[400px] max-h-[600px] overflow-y-auto bg-slate-950 border border-white/10 rounded-xl p-4 font-mono text-xs text-slate-300 leading-relaxed"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-600">
            {selectedContainer ? "No logs loaded — click Load Logs" : "Select a namespace, pod, and container to view logs"}
          </div>
        ) : (
          filteredLogs.map((line, i) => {
            const level = getLineLevel(line);
            return (
              <div key={i} className={cn(
                "group flex items-start py-0.5 hover:bg-white/5 px-1 rounded",
                level === "ERROR" && "text-red-400",
                level === "WARN" && "text-yellow-400",
                level === "INFO" && "text-blue-300",
              )}>
                <span className="text-slate-600 select-none mr-3 shrink-0">{(i + 1).toString().padStart(4, " ")}</span>
                <span className="flex-1 break-all">{line}</span>
                <CopyLineButton line={line} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
