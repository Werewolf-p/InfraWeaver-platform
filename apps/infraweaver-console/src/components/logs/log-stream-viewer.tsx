"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  WrapText,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type LogLevel = "ALL" | "ERROR" | "WARN" | "INFO";

function getLineLevel(line: string): LogLevel {
  const value = line.toLowerCase();
  if (value.includes("error") || value.includes("fatal") || value.includes("critical")) return "ERROR";
  if (value.includes("warn") || value.includes("warning")) return "WARN";
  if (value.includes("info") || value.includes("debug")) return "INFO";
  return "ALL";
}

function CopyLineButton({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(line);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="opacity-0 transition-opacity group-hover:opacity-100 text-white/30 hover:text-white/70"
      aria-label="Copy line"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

interface LogStreamViewerProps {
  namespace?: string;
  pod?: string;
  container?: string;
  containers?: string[];
  onContainerChange?: (container: string) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function LogStreamViewer({
  namespace,
  pod,
  container,
  containers = [],
  onContainerChange,
  emptyTitle = "Select a pod",
  emptyDescription = "Choose a pod from the selector to start streaming logs.",
}: LogStreamViewerProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel>("ALL");
  const [refreshToken, setRefreshToken] = useState(0);
  const logsRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const fetchInitialLogs = useCallback(
    async (signal: AbortSignal) => {
      if (!namespace || !pod || !container) {
        setLogs([]);
        return;
      }

      setIsLoading(true);
      setError("");

      try {
        const response = await fetch(
          `/api/logs/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/${encodeURIComponent(container)}?lines=500`,
          { signal }
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!signal.aborted) {
          setLogs(text.split("\n").filter(Boolean));
        }
      } catch (fetchError) {
        if (!signal.aborted) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          setLogs([]);
        }
      } finally {
        if (!signal.aborted) {
          setIsLoading(false);
        }
      }
    },
    [container, namespace, pod]
  );

  useEffect(() => {
    if (!namespace || !pod || !container) {
      closeStream();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLogs([]);
      setError("");
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    let disposed = false;

    const load = async () => {
      await fetchInitialLogs(controller.signal);
      if (disposed || controller.signal.aborted || !follow) {
        return;
      }

      const stream = new EventSource(
        `/api/logs/stream?namespace=${encodeURIComponent(namespace)}&pod=${encodeURIComponent(pod)}&container=${encodeURIComponent(container)}`
      );

      eventSourceRef.current = stream;
      stream.onmessage = (event) => {
        if (disposed) return;
        try {
          const line = JSON.parse(event.data) as string;
          setLogs((current) => [...current, line].slice(-2000));
        } catch {
          // ignore malformed lines
        }
      };
      stream.onerror = () => {
        if (!disposed) {
          setError((current) => current || "Live log stream disconnected.");
        }
        stream.close();
        if (eventSourceRef.current === stream) {
          eventSourceRef.current = null;
        }
      };
    };

    closeStream();
    void load();

    return () => {
      disposed = true;
      controller.abort();
      closeStream();
    };
  }, [container, namespace, pod, follow, refreshToken, fetchInitialLogs, closeStream]);

  useEffect(() => {
    if (follow && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [follow, logs]);

  const filteredLogs = useMemo(
    () =>
      logs.filter((line) => {
        const matchesText = !filter || line.toLowerCase().includes(filter.toLowerCase());
        const matchesLevel = levelFilter === "ALL" || getLineLevel(line) === levelFilter;
        return matchesText && matchesLevel;
      }),
    [filter, levelFilter, logs]
  );

  const levelCounts = useMemo(
    () => ({
      ERROR: logs.filter((line) => getLineLevel(line) === "ERROR").length,
      WARN: logs.filter((line) => getLineLevel(line) === "WARN").length,
      INFO: logs.filter((line) => getLineLevel(line) === "INFO").length,
    }),
    [logs]
  );

  const handleDownload = () => {
    const blob = new Blob([filteredLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${pod ?? "pod"}-${container ?? "container"}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!namespace || !pod) {
    return (
      <div className="flex min-h-[420px] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 px-6 text-center">
        <TerminalSquare className="mb-4 h-10 w-10 text-slate-600" />
        <h3 className="text-lg font-semibold text-white">{emptyTitle}</h3>
        <p className="mt-2 max-w-md text-sm text-slate-400">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 backdrop-blur-sm">
        {containers.length > 0 && onContainerChange && (
          <select
            value={container ?? ""}
            onChange={(event) => onContainerChange(event.target.value)}
            className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
          >
            {containers.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        )}

        <button
          onClick={() => setRefreshToken((current) => current + 1)}
          disabled={!container || isLoading}
          className="inline-flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          {isLoading ? "Loading" : "Refresh"}
        </button>

        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter logs..."
            className="w-full rounded-lg border border-white/10 bg-slate-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/70 p-1">
          {(["ALL", "ERROR", "WARN", "INFO"] as LogLevel[]).map((entry) => {
            const count = entry === "ALL" ? logs.length : levelCounts[entry];
            return (
              <button
                key={entry}
                onClick={() => setLevelFilter(entry)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition",
                  levelFilter === entry
                    ? "bg-white/10 text-white"
                    : "text-slate-400 hover:bg-white/5 hover:text-white"
                )}
              >
                {entry}
                {count > 0 ? <span className="ml-1 text-[10px] text-slate-500">{count}</span> : null}
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setFollow((current) => !current)}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
            follow
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-white/10 bg-slate-950 text-slate-400 hover:text-white"
          )}
        >
          {follow ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          Follow
        </button>

        <button
          onClick={() => setWrap((current) => !current)}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
            wrap
              ? "border-sky-500/30 bg-sky-500/10 text-sky-300"
              : "border-white/10 bg-slate-950 text-slate-400 hover:text-white"
          )}
        >
          <WrapText className="h-4 w-4" />
          Wrap
        </button>

        <span className="text-xs text-slate-500">{filteredLogs.length} lines</span>

        {logs.length > 0 && (
          <>
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
            <button
              onClick={() => setLogs([])}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </button>
          </>
        )}
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div
        ref={logsRef}
        className="min-h-[420px] flex-1 overflow-auto rounded-2xl border border-white/10 bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-200"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            {container ? "No logs matched the current filters." : "Select a container to load logs."}
          </div>
        ) : (
          <div className={cn("space-y-1", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}> 
            {filteredLogs.map((line, index) => {
              const level = getLineLevel(line);
              return (
                <div
                  key={`${index}-${line.slice(0, 24)}`}
                  className={cn(
                    "group flex items-start gap-3 rounded-lg px-2 py-1 hover:bg-white/5",
                    level === "ERROR" && "text-red-300",
                    level === "WARN" && "text-amber-300",
                    level === "INFO" && "text-sky-300"
                  )}
                >
                  <span className="w-10 shrink-0 text-right text-slate-600">{String(index + 1).padStart(4, "0")}</span>
                  <span className="min-w-0 flex-1">{line}</span>
                  <CopyLineButton line={line} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
