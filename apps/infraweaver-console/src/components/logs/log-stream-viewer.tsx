"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  Check,
  Copy,
  Download,
  Info,
  Pause,
  Play,
  RefreshCw,
  Search,
  TerminalSquare,
  Trash2,
  WrapText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";

export type LogLevel = "ALL" | "ERROR" | "WARN" | "INFO" | "DEBUG";

const PREFERENCES_KEY = "infraweaver:log-viewer-preferences";

interface LogViewerPreferences {
  filter: string;
  autoScroll: boolean;
  wrap: boolean;
  levelFilter: LogLevel;
}

function loadViewerPreferences(): LogViewerPreferences {
  if (typeof window === "undefined") {
    return { filter: "", autoScroll: true, wrap: false, levelFilter: "ALL" };
  }

  try {
    const parsed = JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Partial<LogViewerPreferences> | null;
    return {
      filter: typeof parsed?.filter === "string" ? parsed.filter : "",
      autoScroll: typeof parsed?.autoScroll === "boolean" ? parsed.autoScroll : true,
      wrap: typeof parsed?.wrap === "boolean" ? parsed.wrap : false,
      levelFilter: parsed?.levelFilter === "ERROR" || parsed?.levelFilter === "WARN" || parsed?.levelFilter === "INFO" || parsed?.levelFilter === "DEBUG" || parsed?.levelFilter === "ALL"
        ? parsed.levelFilter
        : "ALL",
    };
  } catch {
    return { filter: "", autoScroll: true, wrap: false, levelFilter: "ALL" };
  }
}

function getLineLevel(line: string): LogLevel {
  const value = line.toLowerCase();
  if (value.includes("error") || value.includes("fatal") || value.includes("critical")) return "ERROR";
  if (value.includes("warn") || value.includes("warning")) return "WARN";
  if (value.includes("debug") || value.includes("trace")) return "DEBUG";
  if (value.includes("info")) return "INFO";
  return "ALL";
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function CopyLineButton({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(line);
        toast.success("Copied!");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className="opacity-0 transition-opacity group-hover:opacity-100 text-gray-400 dark:text-white/30 hover:text-white/70"
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
  const [preferences, setPreferences] = useState<LogViewerPreferences>(() => loadViewerPreferences());
  const [refreshToken, setRefreshToken] = useState(0);
  const [pendingLines, setPendingLines] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [bufferedLines, setBufferedLines] = useState(0);
  const logsRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const atBottomRef = useRef(true);
  const autoScrollRef = useRef(true);
  const pausedRef = useRef(false);
  const pausedBufferRef = useRef<string[]>([]);

  const { filter, autoScroll, wrap, levelFilter } = preferences;

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // ignore persistence failures
    }
  }, [preferences]);

  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);

  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const appendIncomingLines = useCallback((lines: string[]) => {
    if (lines.length === 0) return;
    setLogs((current) => [...current, ...lines].slice(-2000));
    if (!autoScrollRef.current && !atBottomRef.current) {
      setPendingLines((current) => current + lines.length);
    }
  }, []);

  const fetchInitialLogs = useCallback(
    async (signal: AbortSignal) => {
      if (!namespace || !pod || !container) {
        setLogs([]);
        return;
      }

      pausedBufferRef.current = [];
      setBufferedLines(0);
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
          setPendingLines(0);
          setBufferedLines(0);
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
      if (disposed || controller.signal.aborted) {
        return;
      }

      const stream = new EventSource(
        `/api/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/logs/stream?container=${encodeURIComponent(container)}`
      );

      eventSourceRef.current = stream;
      stream.onmessage = (event) => {
        if (disposed) return;
        try {
          const line = JSON.parse(event.data) as string;
          if (pausedRef.current) {
            pausedBufferRef.current = [...pausedBufferRef.current, line].slice(-500);
            setBufferedLines(pausedBufferRef.current.length);
            return;
          }
          appendIncomingLines([line]);
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
  }, [appendIncomingLines, container, namespace, pod, refreshToken, fetchInitialLogs, closeStream]);

  useEffect(() => {
    const containerEl = logsRef.current;
    if (!containerEl || !autoScroll) return;
    containerEl.scrollTop = containerEl.scrollHeight;
    atBottomRef.current = true;
  }, [autoScroll, logs]);

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
      DEBUG: logs.filter((line) => getLineLevel(line) === "DEBUG").length,
    }),
    [logs]
  );

  const latestLevelIndexes = useMemo(() => {
    const indexes = {
      ERROR: -1,
      WARN: -1,
      INFO: -1,
    };

    for (let index = filteredLogs.length - 1; index >= 0; index -= 1) {
      const level = getLineLevel(filteredLogs[index] ?? "");
      if (level === "ERROR" && indexes.ERROR < 0) indexes.ERROR = index;
      if (level === "WARN" && indexes.WARN < 0) indexes.WARN = index;
      if (level === "INFO" && indexes.INFO < 0) indexes.INFO = index;
      if (indexes.ERROR >= 0 && indexes.WARN >= 0 && indexes.INFO >= 0) break;
    }

    return indexes;
  }, [filteredLogs]);

  const handleDownload = () => {
    const blob = new Blob([filteredLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${pod ?? "pod"}-${container ?? "container"}.log`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const jumpToIndex = useCallback((index: number) => {
    if (index < 0 || !logsRef.current) return;
    const node = logsRef.current.querySelector(`[data-log-index=\"${index}\"]`);
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  const jumpToLatestLevel = useCallback((level: "ERROR" | "WARN" | "INFO") => {
    jumpToIndex(latestLevelIndexes[level]);
  }, [jumpToIndex, latestLevelIndexes]);

  const jumpToBottom = () => {
    if (!logsRef.current) return;
    logsRef.current.scrollTo({ top: logsRef.current.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setPendingLines(0);
  };

  const handleScroll = () => {
    const containerEl = logsRef.current;
    if (!containerEl) return;
    const atBottom = containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < 24;
    atBottomRef.current = atBottom;
    if (atBottom) {
      setPendingLines(0);
    }
  };

  const copyRecentLogs = async () => {
    const text = filteredLogs.slice(-100).join("\n");
    if (!text) {
      toast.error("No logs to copy");
      return;
    }
    await navigator.clipboard.writeText(text);
    toast.success("Copied!");
  };

  const togglePause = useCallback(() => {
    if (isPaused) {
      const nextLines = pausedBufferRef.current;
      pausedBufferRef.current = [];
      setBufferedLines(0);
      appendIncomingLines(nextLines);
      setIsPaused(false);
      return;
    }

    setIsPaused(true);
  }, [appendIncomingLines, isPaused]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "p") {
        event.preventDefault();
        togglePause();
        return;
      }
      if (key === "e") {
        event.preventDefault();
        jumpToLatestLevel("ERROR");
        return;
      }
      if (key === "w") {
        event.preventDefault();
        jumpToLatestLevel("WARN");
        return;
      }
      if (key === "i") {
        event.preventDefault();
        jumpToLatestLevel("INFO");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [jumpToLatestLevel, togglePause]);

  const handleContextCopy = async (event: React.MouseEvent<HTMLDivElement>) => {
    const selection = window.getSelection()?.toString().trim();
    if (!selection) return;
    event.preventDefault();
    await navigator.clipboard.writeText(selection);
    toast.success("Copied!");
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
            onChange={(event) => setPreferences((current) => ({ ...current, filter: event.target.value }))}
            placeholder="Filter logs..."
            className="w-full rounded-lg border border-white/10 bg-slate-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/70 p-1">
          {(["ALL", "ERROR", "WARN", "INFO", "DEBUG"] as LogLevel[]).map((entry) => {
            const count = entry === "ALL" ? logs.length : levelCounts[entry];
            return (
              <button
                key={entry}
                onClick={() => setPreferences((current) => ({ ...current, levelFilter: entry }))}
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
          onClick={() => {
            setPreferences((current) => ({ ...current, autoScroll: !current.autoScroll }));
            if (autoScroll) {
              return;
            }
            setPendingLines(0);
          }}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
            autoScroll
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-white/10 bg-slate-950 text-slate-400 hover:text-white"
          )}
        >
          <ArrowDown className="h-4 w-4" />
          {autoScroll ? "Auto-scroll" : "Manual scroll"}
        </button>

        <button
          onClick={() => setPreferences((current) => ({ ...current, wrap: !current.wrap }))}
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

        <button
          onClick={togglePause}
          disabled={!container}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40",
            isPaused
              ? "border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
              : "border-white/10 bg-slate-950 text-slate-300 hover:text-white"
          )}
          title={isPaused ? "Resume the live stream" : "Pause the live stream without disconnecting"}
        >
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {isPaused ? `Resume${bufferedLines > 0 ? ` · ${bufferedLines}` : ""}` : "Pause"}
        </button>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/70 p-1">
          {[
            {
              level: "ERROR",
              label: "Error",
              icon: AlertCircle,
              activeClass: "text-red-300 hover:bg-red-500/10",
            },
            {
              level: "WARN",
              label: "Warn",
              icon: AlertTriangle,
              activeClass: "text-amber-200 hover:bg-amber-500/10",
            },
            {
              level: "INFO",
              label: "Info",
              icon: Info,
              activeClass: "text-sky-300 hover:bg-sky-500/10",
            },
          ].map(({ level, label, icon: Icon, activeClass }) => {
            const index = latestLevelIndexes[level as "ERROR" | "WARN" | "INFO"];
            return (
              <button
                key={level}
                onClick={() => jumpToLatestLevel(level as "ERROR" | "WARN" | "INFO")}
                disabled={index < 0}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                  index >= 0 ? activeClass : "text-slate-500"
                )}
                title={index >= 0 ? `Jump to latest ${label.toLowerCase()} line` : `No ${label.toLowerCase()} lines available`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </div>

        <span className="text-xs text-slate-500">
          {filteredLogs.length} lines{bufferedLines > 0 ? ` · ${bufferedLines} buffered` : ""}
        </span>

        {logs.length > 0 && (
          <>
            <button
              onClick={copyRecentLogs}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              <Copy className="h-4 w-4" />
              Copy last 100
            </button>
            <button
              onClick={handleDownload}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              <Download className="h-4 w-4" />
              Download
            </button>
            <button
              onClick={() => { setLogs([]); setPendingLines(0); }}
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

      {!autoScroll && pendingLines > 0 ? (
        <button
          onClick={jumpToBottom}
          className="self-end rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-300 transition hover:bg-indigo-500/20"
        >
          Jump to bottom · {pendingLines} new
        </button>
      ) : null}

      {isPaused ? (
        <div className="flex items-center justify-between rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <span>Live stream paused{bufferedLines > 0 ? ` · ${bufferedLines} lines queued locally` : ""}</span>
          <button onClick={togglePause} className="rounded-lg border border-amber-500/30 px-3 py-1 text-xs font-medium text-amber-100 transition hover:bg-amber-500/10">
            Resume
          </button>
        </div>
      ) : null}

      <div
        ref={logsRef}
        onScroll={handleScroll}
        onContextMenu={(event) => { void handleContextCopy(event); }}
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
                  data-log-index={index}
                  className={cn(
                    "group flex items-start gap-3 rounded-lg px-2 py-1 hover:bg-white/5",
                    level === "ERROR" && "text-red-300",
                    level === "WARN" && "text-amber-300",
                    level === "INFO" && "text-sky-300",
                    level === "DEBUG" && "text-slate-400"
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
