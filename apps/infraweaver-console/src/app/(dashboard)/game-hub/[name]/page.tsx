"use client";

import { Fragment, useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, Play, Square, RotateCcw, Loader2, Terminal,
  Settings, FolderOpen, Activity, File, Folder, Save, Trash2,
  RefreshCw, Copy, ArrowUp, Send, Circle, AlertTriangle,
  Cpu, LayoutDashboard, Shield, Wifi, Layers, Download,
  FileText, Users, Search, Clock, Package, Plus, X, HardDrive
} from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { getEggForGameType } from "@/lib/game-eggs";
import { toast } from "sonner";
import Link from "next/link";
import dynamic from "next/dynamic";
import { DashboardTab as DashboardTabFeature } from "@/components/game-hub/server-detail/dashboard-tab";
import { PlayersTab as PlayersTabFeature } from "@/components/game-hub/server-detail/players-tab";
import { ActivityTab as ActivityTabFeature } from "@/components/game-hub/server-detail/activity-tab";
import type { FileEntry, SavedCommand, ServerDetail } from "@/components/game-hub/server-detail/types";
import { fetchJson } from "@/components/game-hub/server-detail/utils";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type TabId = "dashboard" | "console" | "players" | "files" | "settings" | "activity";
type RuntimeSavedCommand = SavedCommand & { id?: string; cmd?: string; command?: string; color?: string; description?: string };
type RuntimeQuickCommand = { label: string; command?: string; cmd?: string; description?: string; color?: string };
type EditablePort = { id: string; name: string; port: number; targetPort: number; protocol: string };

const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s*/;
const CONSOLE_PREFS_KEY = "infraweaver:console-prefs";
const CONSOLE_HISTORY_KEY = "infraweaver:console-history";
const RECENT_FILES_KEY = "infraweaver:recent-files";
const ICON_OPTIONS = ["🎮", "🕹️", "🎯", "🏆", "🎲", "🎸", "🔥", "💥", "⚔️", "🛡️", "🌍", "🌟", "💎", "🚀", "🏰", "🎪", "🎭", "🎬", "🎤", "🎵"];

function normalizeCommandValue(entry: { command?: string; cmd?: string }) {
  return entry.command ?? entry.cmd ?? "";
}

function normalizeSavedCommands(entries: ServerDetail["savedCommands"] | undefined): RuntimeSavedCommand[] {
  return ((entries ?? []) as RuntimeSavedCommand[]).map((entry) => ({ ...entry, command: normalizeCommandValue(entry) }));
}

function normalizeQuickCommands(entries: Array<{ label: string; command?: string; description?: string }> | undefined): Array<{ label: string; command: string; description?: string }> {
  return ((entries ?? []) as RuntimeQuickCommand[])
    .map((entry) => ({ label: entry.label, command: normalizeCommandValue(entry), description: entry.description }))
    .filter((entry) => entry.command.trim().length > 0);
}

function readConsolePrefs() {
  if (typeof window === "undefined") return {} as Partial<{ autoScroll: boolean; showTimestamps: boolean; wordWrap: boolean; levelFilter: "all" | "error" | "warn" | "info"; regexMode: boolean }>;
  try {
    return JSON.parse(sessionStorage.getItem(CONSOLE_PREFS_KEY) ?? "{}");
  } catch {
    return {} as Partial<{ autoScroll: boolean; showTimestamps: boolean; wordWrap: boolean; levelFilter: "all" | "error" | "warn" | "info"; regexMode: boolean }>;
  }
}

function readRecentFiles(name: string) {
  if (typeof window === "undefined") return [] as string[];
  try {
    return JSON.parse(localStorage.getItem(`${RECENT_FILES_KEY}:${name}`) ?? "[]") as string[];
  } catch {
    return [] as string[];
  }
}

function downloadTextFile(filename: string, content: string, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatScheduledValue(value: string | null | undefined) {
  return value ? new Date(value).toISOString().slice(0, 16) : "";
}

function stringifyEnv(env: ServerDetail["env"]) {
  return env.map((entry) => `${entry.name}=${entry.value ?? ""}`).join("\n");
}

function DashboardTab({ server, name }: { server: ServerDetail; name: string }) {
  return <DashboardTabFeature name={name} server={server} />;
}

function ConsoleTab({ name, status, server }: { name: string; status: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const [logLines, setLogLines] = useState<Array<{ type: string; line: string; id: number; timestamp?: string | null }>>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podLabel, setPodLabel] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [reconnectBanner, setReconnectBanner] = useState<string | null>(null);
  const consolePrefs = readConsolePrefs();
  const [autoScroll, setAutoScroll] = useState(consolePrefs.autoScroll !== false);
  const [showTimestamps, setShowTimestamps] = useState(consolePrefs.showTimestamps !== false);
  const [wordWrap, setWordWrap] = useState(consolePrefs.wordWrap !== false);
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warn" | "info">((consolePrefs.levelFilter as "all" | "error" | "warn" | "info") ?? "all");
  const [regexMode, setRegexMode] = useState(Boolean(consolePrefs.regexMode));
  const logEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const logIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const historyIdxRef = useRef(-1);
  const lastLogTimestampRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const connectRef = useRef<() => void>(() => undefined);
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const eggCommands = normalizeQuickCommands(server.egg?.quickCommands);
  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const isConnected = status !== "stopped" && connected;

  const addLine = useCallback((type: string, line: string, timestamp?: string | null) => {
    setLogLines((prev) => [...prev.slice(-1000), { type, line, timestamp, id: logIdRef.current++ }]);
  }, []);

  const showBanner = useCallback((message: string | null, durationMs?: number) => {
    if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    setReconnectBanner(message);
    if (message && durationMs) {
      bannerTimeoutRef.current = setTimeout(() => setReconnectBanner(null), durationMs);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(CONSOLE_PREFS_KEY) ?? "{}");
      setAutoScroll(stored.autoScroll !== false);
      setShowTimestamps(stored.showTimestamps !== false);
      setWordWrap(stored.wordWrap !== false);
      setLevelFilter((stored.levelFilter as "all" | "error" | "warn" | "info") ?? "all");
      setRegexMode(Boolean(stored.regexMode));
    } catch {
      // ignore
    }
    try {
      const storedHistory = JSON.parse(localStorage.getItem(`${CONSOLE_HISTORY_KEY}:${name}`) ?? "[]") as string[];
      setHistory(storedHistory.filter((entry) => typeof entry === "string").slice(0, 50));
    } catch {
      setHistory([]);
    }
  }, [name]);

  useEffect(() => {
    try {
      sessionStorage.setItem(CONSOLE_PREFS_KEY, JSON.stringify({ autoScroll, showTimestamps, wordWrap, levelFilter, regexMode }));
    } catch {
      // ignore
    }
  }, [autoScroll, levelFilter, regexMode, showTimestamps, wordWrap]);

  useEffect(() => {
    try {
      localStorage.setItem(`${CONSOLE_HISTORY_KEY}:${name}`, JSON.stringify(history.slice(0, 50)));
    } catch {
      // ignore
    }
  }, [history, name]);

  const connect = useCallback(() => {
    if (status === "stopped") return;
    if (retryRef.current) clearTimeout(retryRef.current);
    esRef.current?.close();

    const params = new URLSearchParams();
    if (lastLogTimestampRef.current) params.set("sinceTime", lastLogTimestampRef.current);
    else params.set("tail", "200");

    const es = new EventSource(`/api/game-hub/servers/${name}/logs?${params.toString()}`);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; line?: string; pod?: string; timestamp?: string };
        if (msg.type === "connected") {
          const isReconnect = hasConnectedRef.current;
          retryCountRef.current = 0;
          setConnected(true);
          setPodLabel(msg.pod ?? name);
          if (!hasConnectedRef.current) {
            addLine("system", `▶ Connected to ${msg.pod ?? name}`);
            hasConnectedRef.current = true;
          } else if (isReconnect) {
            showBanner("Reconnected", 2500);
          }
          return;
        }

        if ((msg.type === "log" || msg.type === "error") && msg.line) {
          const lineTimestamp = msg.timestamp ?? msg.line.match(ISO_TIMESTAMP_PREFIX)?.[0]?.trim() ?? null;
          if (lineTimestamp) lastLogTimestampRef.current = lineTimestamp;
          const cleanLine = msg.line.replace(ISO_TIMESTAMP_PREFIX, "");
          addLine(msg.type === "error" ? "error" : "log", cleanLine || msg.line, lineTimestamp);
        }
      } catch {
        // ignore keep-alive messages
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      const delay = Math.min(2000 * 2 ** retryCountRef.current, 30000);
      retryCountRef.current += 1;
      showBanner(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`);
      retryRef.current = setTimeout(() => connectRef.current(), delay);
    };
  }, [addLine, name, showBanner, status]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (status === "stopped") {
      showBanner(null);
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
      return () => undefined;
    }

    retryCountRef.current = 0;
    connect();
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
      esRef.current?.close();
    };
  }, [connect, showBanner, status]);

  useEffect(() => {
    if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [autoScroll, logLines]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function sendCommand(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || sending) return;
    if (trimmed.length > 512) {
      toast.error("Command too long (max 512 chars)");
      return;
    }

    setSending(true);
    setCommand("");
    historyIdxRef.current = -1;
    setHistory((prev) => [trimmed, ...prev.filter((entry) => entry !== trimmed)].slice(0, 50));
    addLine("input", `❯ ${trimmed}`, new Date().toISOString());
    try {
      const result = await fetchJson<{ stdout?: string; stderr?: string; error?: string }>(`/api/game-hub/servers/${name}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
      });
      if (result.error) addLine("error", result.error, new Date().toISOString());
      if (result.stdout) result.stdout.split("\n").filter(Boolean).forEach((line) => addLine("output", line, new Date().toISOString()));
      if (result.stderr) result.stderr.split("\n").filter(Boolean).forEach((line) => addLine("error", line, new Date().toISOString()));
    } catch (error) {
      addLine("error", String(error));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function saveCurrentCommand() {
    const trimmed = command.trim();
    if (!trimmed) return;
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-command", command: { label: trimmed, cmd: trimmed } }),
      });
      toast.success("Saved command");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function deleteSavedCommand(entry: RuntimeSavedCommand) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-saved-command", commandId: entry.id }),
      });
      toast.success("Saved command removed");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, history.length - 1);
      historyIdxRef.current = next;
      setCommand(history[next] ?? "");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = next;
      setCommand(next < 0 ? "" : (history[next] ?? ""));
    }
  }

  const lineColor = (type: string) => ({ system: "text-blue-400/80", error: "text-red-400", input: "text-yellow-300", output: "text-cyan-300" }[type] ?? "text-[#ccc]");
  const detectLogLevel = useCallback((type: string, line: string) => {
    const value = line.toLowerCase();
    if (type === "error" || /\b(error|fatal|panic)\b/.test(value)) return "error" as const;
    if (/\bwarn(ing)?\b/.test(value)) return "warn" as const;
    return "info" as const;
  }, []);
  const renderedLine = useCallback((entry: { line: string; timestamp?: string | null }) => {
    if (!showTimestamps || !entry.timestamp) return entry.line;
    return `${entry.timestamp} ${entry.line}`;
  }, [showTimestamps]);
  const searchRegex = useMemo(() => {
    if (!regexMode || !searchTerm.trim()) return null;
    try {
      return new RegExp(searchTerm, "i");
    } catch {
      return null;
    }
  }, [regexMode, searchTerm]);
  const visibleLogLines = useMemo(() => logLines.filter((entry) => {
    if (levelFilter === "all") return true;
    return detectLogLevel(entry.type, entry.line) === levelFilter;
  }), [detectLogLevel, levelFilter, logLines]);
  const lineMatchesSearch = useCallback((entry: { line: string; timestamp?: string | null }) => {
    if (!searchTerm.trim()) return false;
    const value = renderedLine(entry);
    return searchRegex ? searchRegex.test(value) : value.toLowerCase().includes(searchTerm.toLowerCase());
  }, [renderedLine, searchRegex, searchTerm]);
  const matches = searchTerm ? visibleLogLines.filter((line) => lineMatchesSearch(line)).map((line) => line.id) : [];
  const jumpToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
    lineRefs.current[matches[next]]?.scrollIntoView({ block: "center" });
  };
  const handleConsoleScroll = () => {
    const element = consoleRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setAutoScroll(nearBottom);
  };

  return (
    <div className="flex flex-col rounded-xl border border-[#2a2a2a] bg-[#0a0a0a] overflow-hidden" style={{ height: "calc(100vh - 280px)", minHeight: "360px" }}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-[#111] border-b border-[#1e1e1e] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Circle className={cn("w-2 h-2", isConnected ? "fill-green-400 text-green-400" : "fill-[#444] text-[#444]")} />
          <span className={cn("text-xs truncate", isConnected ? "text-green-400" : "text-[#555]")}>{isConnected ? podLabel : status === "stopped" ? "Server stopped" : "Connecting…"}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!isConnected && status !== "stopped" && <button onClick={() => { retryCountRef.current = 0; connectRef.current(); }} className="text-xs text-[#0078D4] hover:underline">Reconnect</button>}
          <button onClick={() => setAutoScroll((value) => !value)} className={cn("rounded-md border px-2 py-1 text-[10px] transition-colors", autoScroll ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>{autoScroll ? "Auto-scroll on" : "Auto-scroll off"}</button>
          <button onClick={() => setShowTimestamps((value) => !value)} className={cn("rounded-md border px-2 py-1 text-[10px] transition-colors", showTimestamps ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>Timestamps</button>
          <button onClick={() => setWordWrap((value) => !value)} className={cn("rounded-md border px-2 py-1 text-[10px] transition-colors", wordWrap ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>Wrap</button>
          <button onClick={() => { setSearchOpen((prev) => !prev); setTimeout(() => searchRef.current?.focus(), 0); }} className="p-1.5 text-[#444] hover:text-[#888] hover:bg-[#1e1e1e] rounded transition-colors"><Search className="w-3.5 h-3.5" /></button>
          <div className="flex items-center gap-1">
            {[
              { icon: RefreshCw, label: "Clear", action: () => setLogLines([]) },
              { icon: Copy, label: "Copy all", action: () => { navigator.clipboard.writeText(visibleLogLines.map((line) => renderedLine(line)).join("\n")); toast.success("Copied"); } },
              { icon: Download, label: "Download logs", action: () => downloadTextFile(`${name}-console-${new Date().toISOString().slice(0, 10)}.txt`, visibleLogLines.map((line) => renderedLine(line)).join("\n")) },
            ].map(({ icon: Icon, label, action }) => (
              <button key={label} onClick={action} title={label} className="p-1.5 text-[#444] hover:text-[#888] hover:bg-[#1e1e1e] rounded transition-colors"><Icon className="w-3.5 h-3.5" /></button>
            ))}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[#1e1e1e] bg-[#101010]">
          <Search className="w-3.5 h-3.5 text-[#666]" />
          <input ref={searchRef} value={searchTerm} onChange={(event) => { setSearchTerm(event.target.value); setMatchIndex(0); }} placeholder={regexMode ? "Search console regex..." : "Search console..."} className="min-w-[180px] flex-1 bg-transparent text-sm text-[#f2f2f2] outline-none" />
          <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as "all" | "error" | "warn" | "info")} className="rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1 text-[10px] text-[#bbb] focus:outline-none">
            <option value="all">All levels</option>
            <option value="error">ERROR</option>
            <option value="warn">WARN</option>
            <option value="info">INFO</option>
          </select>
          <button onClick={() => setRegexMode((value) => !value)} className={cn("rounded border px-2 py-1 text-[10px]", regexMode ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>Regex</button>
          <span className="text-xs text-[#666]">{matches.length === 0 ? "0" : `${matchIndex + 1}/${matches.length}`}</span>
          <button onClick={() => jumpToMatch(-1)} className="text-xs text-[#0078D4]">Prev</button>
          <button onClick={() => jumpToMatch(1)} className="text-xs text-[#0078D4]">Next</button>
          <button onClick={() => setSearchOpen(false)} className="text-xs text-[#666]">Esc</button>
          {regexMode && searchTerm && !searchRegex && <span className="text-[10px] text-red-300">Invalid regex</span>}
        </div>
      )}

      {reconnectBanner && status !== "stopped" && <div className="px-4 py-1.5 border-b border-[#1e1e1e] bg-[#111827] text-[11px] text-[#93c5fd]">{reconnectBanner}</div>}

      <div ref={consoleRef} onScroll={handleConsoleScroll} className="flex-1 overflow-y-auto overflow-x-auto p-4 font-mono text-xs leading-[1.7] overscroll-contain select-text">
        {status === "stopped" ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[#444]"><Square className="w-8 h-8" /><p>Server is stopped</p></div>
        ) : visibleLogLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#444] pt-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>{logLines.length === 0 ? "Connecting to log stream…" : "No logs match the current filters."}</span></div>
        ) : visibleLogLines.map((entry) => (
          <div key={entry.id} ref={(element) => { lineRefs.current[entry.id] = element; }} className={cn(wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre", "px-1 rounded min-w-fit transition-opacity", lineColor(entry.type), searchTerm && !matches.includes(entry.id) && "opacity-35", matches.includes(entry.id) && "bg-yellow-400/10", matches[matchIndex] === entry.id && "ring-1 ring-yellow-400/40")}>
            {renderedLine(entry)}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {isConnected && (eggCommands.length > 0 || savedCommands.length > 0) && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d] space-y-3">
          {eggCommands.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">Quick Commands</p>
              <div className="flex gap-1.5 flex-wrap">
                {eggCommands.map((entry) => <button key={`${entry.label}-${entry.command}`} onClick={() => { setCommand(entry.command); inputRef.current?.focus(); }} className="px-2.5 py-1 rounded text-[10px] bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a] text-[#777] hover:text-[#ccc] transition-colors">{entry.label}</button>)}
              </div>
            </div>
          )}
          {savedCommands.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">Saved Commands</p>
              <div className="flex gap-1.5 flex-wrap">
                {savedCommands.map((entry) => (
                  <div key={`${entry.id ?? entry.label}-${entry.command}`} className="flex items-center rounded border border-[#2a2a2a] bg-[#1a1a1a] overflow-hidden">
                    <button onClick={() => { setCommand(entry.command ?? ""); inputRef.current?.focus(); }} className="px-2.5 py-1 text-[10px] text-[#777] hover:text-[#ccc] hover:bg-[#252525] transition-colors">{entry.label}</button>
                    <button onClick={() => deleteSavedCommand(entry)} className="px-1.5 py-1 text-[10px] text-[#555] hover:text-red-300 hover:bg-red-500/10 transition-colors">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-shrink-0 border-t border-[#1a1a1a] p-2 bg-[#0d0d0d]">
        <form onSubmit={sendCommand} className="flex gap-2">
          <div className={cn("flex-1 flex items-center gap-2 bg-[#111] border rounded-lg px-3 min-h-[46px]", isConnected ? "border-[#2a2a2a] focus-within:border-[#0078D4]" : "border-[#1a1a1a] opacity-50")}>
            <span className="text-green-500 font-mono text-sm select-none flex-shrink-0">❯</span>
            <input ref={inputRef} value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={handleKeyDown} placeholder={isConnected ? "Enter command… (↑↓ history)" : "Waiting for connection…"} disabled={!isConnected || sending} autoCapitalize="none" autoCorrect="off" spellCheck={false} className="flex-1 bg-transparent text-[16px] leading-none font-mono text-[#f0f0f0] outline-none placeholder:text-[#333] disabled:cursor-not-allowed py-1" />
          </div>
          <button type="button" onClick={saveCurrentCommand} disabled={!command.trim()} className="px-3 min-h-[46px] bg-[#1a1a1a] hover:bg-[#252525] disabled:opacity-40 text-[#cfcfcf] rounded-lg transition-colors text-xs font-medium flex-shrink-0">Save</button>
          <button type="submit" disabled={!isConnected || sending || !command.trim()} className="flex items-center justify-center w-[50px] min-h-[46px] bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-25 text-white rounded-lg transition-colors touch-manipulation flex-shrink-0">{sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}</button>
        </form>
        <p className="text-[10px] text-[#2a2a2a] mt-1.5 px-1">Universal console • ↑↓ for history</p>
      </div>
    </div>
  );
}


function PlayersTab({ name, server }: { name: string; server: ServerDetail }) {
  return <PlayersTabFeature name={name} server={server} />;
}

function FilesTab({ name, status, mountPath }: { name: string; status: string; mountPath: string }) {
  const [currentPath, setCurrentPath] = useState(mountPath);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pathHistory, setPathHistory] = useState<string[]>([mountPath]);
  const [mobilePane, setMobilePane] = useState<"files" | "editor">("files");
  const [fileSearch, setFileSearch] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "size" | "modified">("name");
  const [recentFiles, setRecentFiles] = useState<string[]>(() => readRecentFiles(name));
  const originalContentRef = useRef<string | null>(null);

  const { data: listing, isLoading, refetch } = useQuery({
    queryKey: ["game-hub", "files", name, currentPath],
    queryFn: () => fetchJson<{ files: FileEntry[] }>(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(currentPath)}`),
    enabled: status !== "stopped",
    retry: 1,
  });

  const fileExt = selectedFile?.name.split(".").pop()?.toLowerCase() ?? "";
  const editorLang = ({ json: "json", yaml: "yaml", yml: "yaml", properties: "ini", conf: "ini", cfg: "ini", log: "plaintext", txt: "plaintext", sh: "shell", py: "python", js: "javascript", ts: "typescript", xml: "xml", toml: "toml" } as Record<string, string>)[fileExt] ?? "plaintext";
  const isImageFile = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(fileExt);
  const isArchiveFile = /\.(tar\.gz|tgz|zip)$/i.test(selectedFile?.name ?? "");
  const isDirty = Boolean(selectedFile && fileContent !== null && fileContent !== originalContentRef.current);

  useEffect(() => {
    try {
      localStorage.setItem(`${RECENT_FILES_KEY}:${name}`, JSON.stringify(recentFiles.slice(0, 5)));
    } catch {
      // ignore
    }
  }, [name, recentFiles]);

  useEffect(() => {
    const handleSaveHotkey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && selectedFile) {
        event.preventDefault();
        if (!saving && !loadingContent && isDirty) void saveFile();
      }
    };
    window.addEventListener("keydown", handleSaveHotkey);
    return () => window.removeEventListener("keydown", handleSaveHotkey);
  }, [isDirty, loadingContent, saveFile, saving, selectedFile]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [isDirty]);

  async function openFile(entry: FileEntry) {
    if (isDirty && !confirm(`Discard unsaved changes in ${selectedFile?.name ?? "this file"}?`)) return;
    if (entry.type === "directory") {
      setPathHistory((history) => [...history, entry.path]);
      setCurrentPath(entry.path);
      setSelectedFile(null);
      setFileContent(null);
      return;
    }

    setSelectedFile(entry);
    setFileContent(null);
    originalContentRef.current = null;
    setLoadingContent(!["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(entry.name.split(".").pop()?.toLowerCase() ?? ""));
    setMobilePane("editor");
    setRecentFiles((prev) => [entry.path, ...prev.filter((item) => item !== entry.path)].slice(0, 5));
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(entry.name.split(".").pop()?.toLowerCase() ?? "")) {
      setFileContent("");
      originalContentRef.current = "";
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await fetchJson<{ content: string }>(`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`, { signal: controller.signal });
      setFileContent(result.content);
      originalContentRef.current = result.content;
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError" ? "File load timed out — server may be busy" : String(error);
      toast.error(message);
    } finally {
      clearTimeout(timer);
      setLoadingContent(false);
    }
  }

  async function saveFile() {
    if (!selectedFile || fileContent === null) return;
    setSaving(true);
    try {
      await fetchJson(`/api/game-hub/servers/${name}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile.path, content: fileContent }),
      });
      originalContentRef.current = fileContent;
      toast.success("File saved");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFile(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await fetchJson(`/api/game-hub/servers/${name}/files?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" });
      toast.success(`${entry.name} deleted`);
      if (selectedFile?.path === entry.path) {
        setSelectedFile(null);
        setFileContent(null);
        originalContentRef.current = null;
      }
      refetch();
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function extractArchive(entry: FileEntry) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/files`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "extract", path: entry.path }),
      });
      toast.success(`Extracted ${entry.name}`);
      refetch();
    } catch (error) {
      toast.error(String(error));
    }
  }

  function goUp() {
    if (pathHistory.length <= 1) return;
    const nextHistory = pathHistory.slice(0, -1);
    setPathHistory(nextHistory);
    setCurrentPath(nextHistory[nextHistory.length - 1]);
    setSelectedFile(null);
    setFileContent(null);
    originalContentRef.current = null;
  }

  const sortedFiles = useMemo(() => {
    const filteredFiles = (listing?.files ?? []).filter((entry) => !fileSearch.trim() || entry.name.toLowerCase().includes(fileSearch.toLowerCase()));
    return [...filteredFiles].sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      if (sortKey === "size") return b.size - a.size;
      if (sortKey === "modified") return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      return a.name.localeCompare(b.name);
    });
  }, [fileSearch, listing?.files, sortKey]);

  const breadcrumbParts = currentPath.split("/").filter(Boolean);
  const recentOpenFiles = recentFiles
    .map((path) => (listing?.files ?? []).find((entry) => entry.path === path) ?? ({ name: path.split("/").pop() ?? path, path, type: "file", size: 0, modifiedAt: new Date().toISOString(), permissions: "" } as FileEntry))
    .slice(0, 5);

  if (status === "stopped") {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-3 text-[#555]">
        <FolderOpen className="w-8 h-8" />
        <p className="text-sm">Start the server to browse files</p>
      </div>
    );
  }

  const fileTree = (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[#2a2a2a] bg-[#111] p-2">
        <div className="flex items-center gap-1 px-1 pb-2">
          <button onClick={goUp} disabled={pathHistory.length <= 1} className="p-1 rounded hover:bg-[#1e1e1e] disabled:opacity-30 transition-colors flex-shrink-0">
            <ArrowUp className="w-3.5 h-3.5 text-[#666]" />
          </button>
          <div className="flex-1 min-w-0 overflow-x-auto scrollbar-none">
            <div className="flex items-center gap-1.5 w-max min-w-full text-[10px] font-mono text-[#777]">
              <button onClick={() => { setCurrentPath(mountPath); setPathHistory([mountPath]); setSelectedFile(null); setFileContent(null); originalContentRef.current = null; }} className="rounded px-1 py-0.5 hover:bg-[#1e1e1e]">root</button>
              {breadcrumbParts.map((part, index) => {
                const nextPath = `/${breadcrumbParts.slice(0, index + 1).join("/")}`;
                return (
                  <Fragment key={nextPath}>
                    <span>/</span>
                    <button onClick={() => { setCurrentPath(nextPath); setPathHistory((history) => [...history.filter((path) => path !== nextPath), nextPath]); setSelectedFile(null); setFileContent(null); originalContentRef.current = null; }} className="rounded px-1 py-0.5 hover:bg-[#1e1e1e]">{part}</button>
                  </Fragment>
                );
              })}
            </div>
          </div>
          <button onClick={() => refetch()} className="p-1 rounded hover:bg-[#1e1e1e] transition-colors flex-shrink-0">
            <RefreshCw className="w-3 h-3 text-[#555]" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#555]" />
            <input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Search files…" className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] py-1.5 pl-8 pr-3 text-xs text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" />
          </div>
          <select value={sortKey} onChange={(event) => setSortKey(event.target.value as "name" | "size" | "modified")} className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-[10px] text-[#bbb] focus:outline-none">
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="modified">Modified</option>
          </select>
        </div>
      </div>
      {recentOpenFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {recentOpenFiles.map((entry) => (
            <button key={entry.path} onClick={() => void openFile(entry)} className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-1 text-[10px] text-[#9e9e9e] hover:text-white">
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20"><Loader2 className="w-4 h-4 animate-spin text-[#555]" /></div>
        ) : sortedFiles.length === 0 ? (
          <p className="text-xs text-[#555] text-center py-6">{fileSearch ? "No files match the current search" : "Empty directory"}</p>
        ) : (
          <div className="p-1 max-h-[55vh] overflow-y-auto overscroll-contain" tabIndex={0} onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const fileEntries = sortedFiles.filter((entry) => entry.type !== "directory");
            if (fileEntries.length === 0) return;
            event.preventDefault();
            const currentIndex = fileEntries.findIndex((entry) => entry.path === selectedFile?.path);
            const nextEntry = fileEntries[(currentIndex + 1 + fileEntries.length) % fileEntries.length];
            void openFile(nextEntry);
          }}>
            {sortedFiles.map((entry) => (
              <div key={entry.path} onClick={() => void openFile(entry)} className={cn("group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors text-xs touch-manipulation", selectedFile?.path === entry.path ? "bg-[rgba(0,120,212,0.2)] text-white" : "hover:bg-[#1a1a1a] text-[#9e9e9e]")}>
                {entry.type === "directory" ? <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" /> : <File className="w-3.5 h-3.5 text-[#444] flex-shrink-0" />}
                <div className="min-w-0 flex-1">
                  <span className={cn("truncate block", fileSearch && entry.name.toLowerCase().includes(fileSearch.toLowerCase()) && "text-white")}>{entry.name}</span>
                  <span className="text-[10px] text-[#555]">{entry.type === "directory" ? `Directory • ${entry.permissions}` : `${entry.permissions} • ${formatBytes(entry.size)} • ${timeAgo(entry.modifiedAt)}`}</span>
                </div>
                {entry.type !== "directory" && /\.(tar\.gz|tgz|zip)$/i.test(entry.name) && (
                  <button onClick={(event) => { event.stopPropagation(); void extractArchive(entry); }} className="opacity-0 group-hover:opacity-100 p-0.5 text-[#444] hover:text-green-300 transition-all" title="Extract here">
                    <Package className="w-3 h-3" />
                  </button>
                )}
                {entry.type !== "directory" && (
                  <button onClick={(event) => { event.stopPropagation(); deleteFile(entry); }} className="opacity-0 group-hover:opacity-100 p-0.5 text-[#444] hover:text-red-400 transition-all">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const editorPane = (
    <div className="flex flex-col gap-2 min-w-0">
      {selectedFile ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setMobilePane("files")} className="md:hidden flex items-center gap-1 text-xs text-[#0078D4] flex-shrink-0">← Files</button>
            <div className="min-w-0 flex-1">
              <span className="text-xs text-[#555] font-mono truncate block">{selectedFile.path}</span>
              <span className="text-[10px] text-[#444]">{selectedFile.permissions || "---------"} • {formatBytes(selectedFile.size)} • {timeAgo(selectedFile.modifiedAt)} {isDirty ? "• Unsaved changes" : "• Saved"}</span>
            </div>
            <button onClick={() => { navigator.clipboard.writeText(fileContent ?? ""); toast.success("Copied"); }} className="p-1.5 text-[#444] hover:text-[#888] flex-shrink-0"><Copy className="w-3.5 h-3.5" /></button>
            {isArchiveFile && <button onClick={() => void extractArchive(selectedFile)} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#252525] text-[#d4d4d4] rounded-lg text-xs font-medium flex-shrink-0"><Package className="w-3 h-3" /> Extract</button>}
            {!isImageFile && <button onClick={saveFile} disabled={saving || loadingContent} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex-shrink-0">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save (Ctrl+S)
            </button>}
          </div>
          <div className="rounded-xl border border-[#2a2a2a] overflow-hidden min-w-0" style={{ height: "55vh", minHeight: "300px" }}>
            {loadingContent ? (
              <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-[#555]" /></div>
            ) : isImageFile ? (
              <div className="flex h-full items-center justify-center bg-[#0a0a0a] p-4"><img src={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(selectedFile.path)}&download=1`} alt={selectedFile.name} className="max-h-full max-w-full rounded border border-[#2a2a2a] object-contain" /></div>
            ) : (
              <MonacoEditor height="100%" language={editorLang} value={fileContent ?? ""} onChange={(value) => setFileContent(value ?? "")} theme="vs-dark" options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: "on", wordWrap: "on", scrollBeyondLastLine: false, padding: { top: 8 } }} />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#111] gap-3" style={{ height: "55vh", minHeight: "200px" }}>
          <FolderOpen className="w-10 h-10 text-[#2a2a2a]" />
          <p className="text-sm text-[#555]">Select a file to edit</p>
          <button onClick={() => setMobilePane("files")} className="md:hidden text-xs text-[#0078D4]">Browse files →</button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="hidden md:grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-4">{fileTree}{editorPane}</div>
      <div className="md:hidden space-y-3">
        <div className="flex gap-1 p-1 bg-[#111] rounded-lg border border-[#2a2a2a]">
          {(["files", "editor"] as const).map((pane) => (
            <button key={pane} onClick={() => setMobilePane(pane)} className={cn("flex-1 py-2.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1.5", mobilePane === pane ? "bg-[#0078D4] text-white" : "text-[#666]")}>
              {pane === "files" ? <Folder className="w-3.5 h-3.5" /> : <File className="w-3.5 h-3.5" />}
              {pane === "editor" && selectedFile ? `${selectedFile.name}${isDirty ? " *" : ""}` : pane === "files" ? "Files" : "Editor"}
            </button>
          ))}
        </div>
        {mobilePane === "files" ? fileTree : editorPane}
      </div>
    </>
  );
}

function ActivityTab({ name }: { name: string }) {
  return <ActivityTabFeature name={name} />;
}

// ─── Per-server RBAC Panel ────────────────────────────────────────────────────

interface RbacAssignment {
  id: string;
  roleId: string;
  scope: string;
  username: string;
  userEmail: string;
  userName: string;
  grantedAt: string;
  expiresAt?: string;
}

const GAME_SERVER_ROLES = [
  { id: "game-server-admin", label: "Admin", description: "Full control over this server" },
  { id: "game-server-operator", label: "Operator", description: "Start/stop, console, file access" },
  { id: "game-server-viewer", label: "Viewer", description: "Read-only access" },
] as const;

function ServerRbacPanel({ serverName }: { serverName: string }) {
  const queryClient = useQueryClient();
  const scope = `/game-hub/servers/${serverName}`;
  const [showAdd, setShowAdd] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addRole, setAddRole] = useState<string>(GAME_SERVER_ROLES[0].id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["rbac-assignments", "game-hub", serverName],
    queryFn: async () => {
      const res = await fetch("/api/rbac/assignments");
      if (!res.ok) throw new Error("Failed to load assignments");
      const result = await res.json() as { assignments: RbacAssignment[] };
      return result.assignments.filter((a) => a.scope === scope);
    },
    staleTime: 30000,
  });

  const { data: usersData } = useQuery({
    queryKey: ["users-config-list"],
    queryFn: async () => {
      const res = await fetch("/api/users-config");
      if (!res.ok) return { users: {} as Record<string, { name?: string; email?: string }> };
      return res.json() as Promise<{ users: Record<string, { name?: string; email?: string }> }>;
    },
    staleTime: 60000,
  });
  const knownUsernames = Object.keys(usersData?.users ?? {}).sort();

  const assignments = data ?? [];

  async function addAssignment() {
    if (!addUsername.trim()) {
      toast.error("Username is required");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/rbac/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: addUsername.trim(), roleId: addRole, scope, principalType: "user" }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to add assignment");
      }
      toast.success(`${addRole} granted to ${addUsername.trim()}`);
      setShowAdd(false);
      setAddUsername("");
      queryClient.invalidateQueries({ queryKey: ["rbac-assignments", "game-hub", serverName] });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setAdding(false);
    }
  }

  async function removeAssignment(assignment: RbacAssignment) {
    setRemoving(assignment.id);
    try {
      const res = await fetch("/api/rbac/assignments", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: assignment.id, username: assignment.username }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to remove assignment");
      }
      toast.success(`Role removed from ${assignment.username}`);
      queryClient.invalidateQueries({ queryKey: ["rbac-assignments", "game-hub", serverName] });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRemoving(null);
    }
  }

  const roleLabel = (roleId: string) => GAME_SERVER_ROLES.find((r) => r.id === roleId)?.label ?? roleId;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">Access Control</p>
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-[#555] font-mono">{scope}</span>
        </div>
        <button
          onClick={() => setShowAdd((prev) => !prev)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0078D4]/15 hover:bg-[#0078D4]/25 text-[#4db3ff] text-xs font-medium transition-colors"
        >
          <Plus className="w-3 h-3" /> Add User
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Add user form */}
        <AnimatePresence>
          {showAdd && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-lg border border-[#0078D4]/30 bg-[#0d1e33] p-4 space-y-3"
            >
              <p className="text-xs font-medium text-[#4db3ff]">Grant server access</p>
              <div className="grid sm:grid-cols-[1fr_160px_auto] gap-2">
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">Username</label>
                  <input
                    value={addUsername}
                    onChange={(e) => setAddUsername(e.target.value)}
                    placeholder="username"
                    list="rbac-users-datalist"
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                    onKeyDown={(e) => e.key === "Enter" && addAssignment()}
                  />
                  <datalist id="rbac-users-datalist">
                    {knownUsernames.map((u) => <option key={u} value={u} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">Role</label>
                  <select
                    value={addRole}
                    onChange={(e) => setAddRole(e.target.value)}
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                  >
                    {GAME_SERVER_ROLES.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end gap-2">
                  <button
                    onClick={addAssignment}
                    disabled={adding}
                    className="px-3 py-2 rounded-lg bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white text-xs font-medium flex items-center gap-1.5"
                  >
                    {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    Grant
                  </button>
                  <button onClick={() => setShowAdd(false)} className="px-3 py-2 rounded-lg bg-[#1a1a1a] text-[#888] text-xs">
                    Cancel
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {GAME_SERVER_ROLES.map((r) => (
                  <div key={r.id} className="text-[10px] text-[#555]">
                    <span className="text-[#888]">{r.label}</span>: {r.description}
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Assignment list */}
        {isLoading && (
          <div className="flex items-center gap-2 text-xs text-[#555]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading assignments…
          </div>
        )}
        {!isLoading && assignments.length === 0 && (
          <p className="text-xs text-[#555]">
            No users have been granted access to this server.
            Platform admins always have full access via their platform role.
          </p>
        )}
        {!isLoading && assignments.length > 0 && (
          <div className="space-y-2">
            {assignments.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2.5"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-[#1e1e1e] flex items-center justify-center text-xs text-[#888] flex-shrink-0 border border-[#2a2a2a]">
                    {(a.userName || a.username).slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm text-[#f2f2f2] truncate">{a.userName || a.username}</p>
                    <p className="text-[10px] text-[#555] truncate">{a.userEmail || a.username}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className={cn(
                    "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                    a.roleId === "game-server-admin"
                      ? "border-red-500/30 bg-red-500/10 text-red-300"
                      : a.roleId === "game-server-operator"
                        ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
                        : "border-[#333] bg-[#1a1a1a] text-[#888]",
                  )}>
                    {roleLabel(a.roleId)}
                  </span>
                  <button
                    onClick={() => removeAssignment(a)}
                    disabled={removing === a.id}
                    title={`Remove ${a.username}'s access`}
                    className="p-1.5 rounded-lg text-[#555] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                  >
                    {removing === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const envImportRef = useRef<HTMLInputElement>(null);
  const defaultEgg = getEggForGameType(server.gameType);
  const defaultEnv = Object.fromEntries((defaultEgg.environment ?? []).map((entry) => [entry.name, entry.defaultValue]));
  const currentEnv = Object.fromEntries(server.env.map((entry) => [entry.name, entry.value ?? ""]));
  const envDiff = [...new Set([...Object.keys(defaultEnv), ...Object.keys(currentEnv)])]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const defaultValue = defaultEnv[key];
      const currentValue = currentEnv[key];
      const state = defaultValue === undefined
        ? "added"
        : currentValue === undefined
          ? "removed"
          : currentValue !== defaultValue
            ? "changed"
            : "same";
      return { key, defaultValue, currentValue, state };
    })
    .filter((entry) => entry.state !== "same");
  const isLonghornPvc = Boolean(server.pvc?.storageClass?.toLowerCase().includes("longhorn"));

  const [replicaMode, setReplicaMode] = useState<"static" | "dynamic">(server.hpa.enabled ? "dynamic" : "static");
  const [staticCount, setStaticCount] = useState(Math.max(server.replicas ?? 1, 1));
  const [hpaMin, setHpaMin] = useState(server.hpa.min);
  const [hpaMax, setHpaMax] = useState(server.hpa.max);
  const [hpaCpu, setHpaCpu] = useState(server.hpa.cpuTarget ?? 70);
  const [scaleSaving, setScaleSaving] = useState(false);
  const [autoRestart, setAutoRestart] = useState(server.restartPolicy !== "OnFailure");
  const [savingRestart, setSavingRestart] = useState(false);
  const [notes, setNotes] = useState(server.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [memLimit, setMemLimit] = useState(server.memory ?? "");
  const [cpuLimit, setCpuLimit] = useState(server.cpu ?? "");
  const [savingResources, setSavingResources] = useState(false);
  const [editingEnv, setEditingEnv] = useState(false);
  const [envStr, setEnvStr] = useState(stringifyEnv(server.env));
  const [savingEnv, setSavingEnv] = useState(false);
  const [description, setDescription] = useState(server.description ?? "");
  const [icon, setIcon] = useState(server.icon ?? "🎮");
  const [tagsStr, setTagsStr] = useState((server.tags ?? []).join(", "));
  const [groupsStr, setGroupsStr] = useState((server.groups ?? []).join(", "));
  const [image, setImage] = useState(server.image ?? "");
  const [imagePullPolicy, setImagePullPolicy] = useState(server.imagePullPolicy ?? "IfNotPresent");
  const [deploymentStrategy, setDeploymentStrategy] = useState(server.deploymentStrategy ?? "RollingUpdate");
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlContent, setYamlContent] = useState(server.deploymentYaml ?? "");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [servicePorts, setServicePorts] = useState<EditablePort[]>((server.allPorts ?? []).map((port, index) => ({ id: `${port.name ?? "port"}-${index}`, name: port.name ?? "", port: port.port, targetPort: Number(port.targetPort ?? port.port), protocol: port.protocol })));
  const [scheduledAction, setScheduledAction] = useState(server.scheduledAction ?? "none");
  const [scheduledTime, setScheduledTime] = useState(formatScheduledValue(server.scheduledTime));
  const [commandLabel, setCommandLabel] = useState("");
  const [commandText, setCommandText] = useState("");

  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const { data: snapshotsData, refetch: refetchSnapshots, isFetching: snapshotsLoading } = useQuery({
    queryKey: ["game-hub", "snapshots", name],
    queryFn: () => fetchJson<{ snapshots: Array<{ metadata?: { name?: string; creationTimestamp?: string; annotations?: Record<string, string> }; status?: { readyToUse?: boolean } }> }>(`/api/game-hub/servers/${name}/snapshot`),
    enabled: isLonghornPvc,
  });

  async function patchServer(body: unknown, successMessage: string) {
    await fetchJson(`/api/game-hub/servers/${name}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast.success(successMessage);
    queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
  }

  async function saveReplicas() {
    setScaleSaving(true);
    try {
      if (replicaMode === "static") {
        await patchServer({ action: "scale", replicas: staticCount }, `Set to ${staticCount} replica${staticCount !== 1 ? "s" : ""}`);
      } else {
        await patchServer({ action: "set-hpa", hpaMin, hpaMax, hpaCpuTarget: hpaCpu }, `Auto-scale enabled: ${hpaMin}–${hpaMax} replicas @ ${hpaCpu}% CPU`);
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setScaleSaving(false);
    }
  }

  async function toggleAutoRestart() {
    const next = !autoRestart;
    setSavingRestart(true);
    try {
      await patchServer({ action: "set-restart-policy", restartPolicy: next }, next ? "Crash restart enabled" : "Crash restart limited to failures only");
      setAutoRestart(next);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingRestart(false);
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await patchServer({ action: "set-notes", notes }, "Server notes saved");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingNotes(false);
    }
  }

  async function saveResources() {
    if (!memLimit.trim() || !cpuLimit.trim()) {
      toast.error("Memory and CPU limits are required");
      return;
    }
    setSavingResources(true);
    try {
      await patchServer({ action: "update-resources", memory: memLimit.trim(), cpu: cpuLimit.trim() }, "Resource limits updated");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingResources(false);
    }
  }

  async function saveEnv() {
    setSavingEnv(true);
    try {
      const env: Record<string, string> = {};
      for (const line of envStr.split("\n")) {
        const index = line.indexOf("=");
        if (index < 0) continue;
        env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
      await patchServer({ action: "update-env", env }, "Saved — restart the server to apply changes");
      setEditingEnv(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingEnv(false);
    }
  }

  function exportEnv() {
    downloadTextFile(`${name}.env`, editingEnv ? envStr : stringifyEnv(server.env));
  }

  async function importEnvFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setEnvStr(await file.text());
      setEditingEnv(true);
      toast.success(".env imported");
    } catch (error) {
      toast.error(String(error));
    } finally {
      event.target.value = "";
    }
  }

  async function saveIdentity() {
    try {
      await patchServer({ action: "update-identity", description, icon, tags: tagsStr.split(",").map((tag) => tag.trim()).filter(Boolean), groups: groupsStr.split(",").map((group) => group.trim()).filter(Boolean) }, "Server identity updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveImage() {
    try {
      await patchServer({ action: "update-image", image }, "Container image updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function savePullPolicy() {
    try {
      await patchServer({ action: "update-pull-policy", pullPolicy: imagePullPolicy }, "Pull policy updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveStrategy() {
    try {
      await patchServer({ action: "update-strategy", strategy: deploymentStrategy }, "Deployment strategy updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function rollbackDeployment() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/rollback`, { method: "POST" });
      toast.success("Rollback requested");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function viewYaml() {
    setYamlLoading(true);
    setYamlOpen(true);
    try {
      const result = await fetchJson<ServerDetail>(`/api/game-hub/servers/${name}?includeYaml=1`);
      setYamlContent(result.deploymentYaml ?? "# YAML unavailable");
    } catch (error) {
      toast.error(String(error));
      setYamlContent("# Failed to load deployment YAML");
    } finally {
      setYamlLoading(false);
    }
  }

  function updatePort(id: string, patch: Partial<EditablePort>) {
    setServicePorts((ports) => ports.map((port) => port.id === id ? { ...port, ...patch } : port));
  }

  function addPortRow() {
    setServicePorts((ports) => [...ports, { id: `${Date.now()}-${ports.length}`, name: "", port: 25565, targetPort: 25565, protocol: "TCP" }]);
  }

  function removePortRow(id: string) {
    setServicePorts((ports) => ports.filter((port) => port.id !== id));
  }

  async function savePorts() {
    try {
      const ports = servicePorts
        .filter((port) => port.port > 0)
        .map((port) => ({ name: port.name || undefined, port: Number(port.port), targetPort: Number(port.targetPort || port.port), protocol: port.protocol as "TCP" | "UDP" }));
      await patchServer({ action: "update-service-ports", ports }, "Service ports updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveScheduledAction() {
    try {
      await patchServer({ action: "set-scheduled-action", scheduledAction: scheduledAction === "none" ? null : scheduledAction, scheduledTime: scheduledTime || null }, "Scheduled action updated");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function createSnapshot() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      toast.success("Snapshot requested");
      refetchSnapshots();
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveQuickCommand() {
    const label = commandLabel.trim();
    const cmd = commandText.trim();
    if (!label || !cmd) {
      toast.error("Label and command are required");
      return;
    }
    try {
      await patchServer({ action: "save-command", command: { label, cmd } }, "Saved command added");
      setCommandLabel("");
      setCommandText("");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function deleteQuickCommand(entry: RuntimeSavedCommand) {
    try {
      await patchServer({ action: "delete-saved-command", commandId: entry.id }, "Saved command removed");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function exportServer() {
    try {
      const result = await fetchJson<ServerDetail>(`/api/game-hub/servers/${name}`);
      downloadTextFile(`${name}-config.json`, JSON.stringify({
        name: result.name,
        gameType: result.gameType,
        dockerImage: result.image,
        env: Object.fromEntries(result.env.map((entry) => [entry.name, entry.value ?? ""])),
        ports: result.allPorts,
        resources: { cpu: result.cpu, memory: result.memory },
        replicas: result.replicas,
        pvcSize: result.pvc?.size ?? null,
        egg: result.egg,
      }, null, 2), "application/json");
      toast.success("Server export downloaded");
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Layers className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Replica Scaling</p>{server.hpa.enabled && <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/20">HPA active</span>}</div>
        <div className="p-4 space-y-4">
          {server.replicas === 0 && <p className="text-xs text-[#888] rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2">Server is stopped (0 replicas running). Use the Start button above to start it.</p>}
          <div className="flex gap-2">{(["static", "dynamic"] as const).map((mode) => <button key={mode} onClick={() => setReplicaMode(mode)} className={cn("flex-1 py-2 rounded-lg text-xs font-medium transition-colors border", replicaMode === mode ? "bg-[#0078D4]/20 border-[#0078D4]/50 text-[#0078D4]" : "bg-transparent border-[#2a2a2a] text-[#666] hover:text-[#888]")}>{mode === "static" ? "Static (fixed)" : "Dynamic (HPA)"}</button>)}</div>
          {replicaMode === "static" ? (
            <div className="flex items-center gap-3"><label className="text-xs text-[#666] flex-shrink-0">Replicas</label><div className="flex items-center gap-1"><button onClick={() => setStaticCount((count) => Math.max(1, count - 1))} className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] text-sm font-bold flex items-center justify-center">−</button><span className="w-8 text-center text-sm font-mono text-[#f2f2f2]">{staticCount}</span><button onClick={() => setStaticCount((count) => Math.min(10, count + 1))} className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] text-[#888] text-sm font-bold flex items-center justify-center">+</button></div></div>
          ) : (
            <div className="space-y-3"><div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><div><label className="block text-[10px] text-[#666] mb-1">Min replicas</label><input type="number" min={1} max={10} value={hpaMin} onChange={(event) => setHpaMin(Math.max(1, parseInt(event.target.value, 10) || 1))} className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" /></div><div><label className="block text-[10px] text-[#666] mb-1">Max replicas</label><input type="number" min={1} max={10} value={hpaMax} onChange={(event) => setHpaMax(Math.max(hpaMin, parseInt(event.target.value, 10) || 1))} className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" /></div><div><label className="block text-[10px] text-[#666] mb-1">CPU target %</label><input type="number" min={10} max={100} value={hpaCpu} onChange={(event) => setHpaCpu(Math.min(100, Math.max(10, parseInt(event.target.value, 10) || 70)))} className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]" /></div></div>{server.hpa.currentReplicas !== null && <p className="text-[10px] text-[#555]">Currently running {server.hpa.currentReplicas} replica(s) via HPA</p>}</div>
          )}
          <button onClick={saveReplicas} disabled={scaleSaving} className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">{scaleSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Apply scaling</button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><RotateCcw className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Auto-restart Policy</p></div><div className="p-4 flex items-center justify-between gap-4"><div><p className="text-sm text-[#f2f2f2]">Restart on crash</p><p className="text-xs text-[#555] mt-0.5">Automatically restart if the server process exits unexpectedly</p></div><button onClick={toggleAutoRestart} disabled={savingRestart} className={cn("relative w-11 h-6 rounded-full transition-colors flex-shrink-0", autoRestart ? "bg-[#0078D4]" : "bg-[#2a2a2a]")}><span className={cn("absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow", autoRestart ? "translate-x-5" : "translate-x-0")} /></button></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]"><div className="flex items-center gap-2"><FileText className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Server Notes</p></div><button onClick={saveNotes} disabled={savingNotes} className="text-xs text-[#0078D4] hover:underline">{savingNotes ? "Saving..." : "Save"}</button></div><div className="p-4"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} placeholder="Add notes about this server, connection info, admin contacts..." className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] placeholder:text-[#333]" /></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Cpu className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Resource Limits</p></div><div className="p-4 space-y-3"><div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="block text-[10px] text-[#666] mb-1">Memory limit</label><input value={memLimit} onChange={(event) => setMemLimit(event.target.value)} placeholder="e.g. 2Gi, 512Mi" className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /></div><div><label className="block text-[10px] text-[#666] mb-1">CPU limit</label><input value={cpuLimit} onChange={(event) => setCpuLimit(event.target.value)} placeholder="e.g. 1, 500m" className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /></div></div><button onClick={saveResources} disabled={savingResources} className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">{savingResources ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Apply limits</button></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]"><div className="flex items-center gap-2"><Shield className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Environment Variables</p></div><div className="flex items-center gap-3"><button onClick={exportEnv} className="text-xs text-[#9e9e9e] hover:text-white">Export .env</button><button onClick={() => envImportRef.current?.click()} className="text-xs text-[#9e9e9e] hover:text-white">Import .env</button><button onClick={() => setEditingEnv((prev) => !prev)} className="text-xs text-[#0078D4] hover:underline">{editingEnv ? "Cancel" : "Edit"}</button></div></div><input ref={envImportRef} type="file" accept=".env,text/plain" className="hidden" onChange={importEnvFile} /><div className="p-4 space-y-4">{editingEnv ? (<div className="space-y-3"><p className="text-xs text-[#555]">One <code className="text-[#888]">KEY=VALUE</code> per line. Sensitive values are hidden in display mode.</p><textarea value={envStr} onChange={(event) => setEnvStr(event.target.value)} rows={12} className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm font-mono text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] leading-relaxed" /><button onClick={saveEnv} disabled={savingEnv} className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] text-white rounded-lg text-sm font-medium disabled:opacity-50">{savingEnv ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save changes</button></div>) : (<div className="space-y-2 max-h-72 overflow-y-auto">{server.env.length === 0 ? <p className="text-xs text-[#555]">No environment variables set.</p> : server.env.map((entry) => <div key={entry.name} className="flex items-start gap-2 text-xs py-0.5"><span className="font-mono text-[#0078D4] flex-shrink-0 w-24 sm:min-w-[120px] break-all">{entry.name}</span><span className="text-[#444]">=</span><span className={cn("font-mono break-all", entry.name.match(/PASS|SECRET|KEY|TOKEN/i) ? "text-[#444] italic" : "text-[#9e9e9e]")}>{entry.name.match(/PASS|SECRET|KEY|TOKEN/i) ? "••••••••" : (entry.value ?? "<from secret>")}</span></div>)}</div>)}<div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3"><p className="text-[11px] uppercase tracking-wide text-[#666] mb-2">Config Diff vs Egg Defaults</p>{envDiff.length === 0 ? <p className="text-xs text-[#555]">No differences from the egg defaults.</p> : <div className="space-y-2">{envDiff.map((entry) => <div key={entry.key} className={cn("rounded border px-3 py-2 text-xs", entry.state === "added" ? "border-green-500/20 bg-green-500/5" : entry.state === "removed" ? "border-red-500/20 bg-red-500/5" : "border-yellow-500/20 bg-yellow-500/5")}><div className="font-mono text-[#f2f2f2]">{entry.key}</div><div className="mt-1 text-[#777]">Default: <span className="font-mono">{entry.defaultValue ?? "<unset>"}</span></div><div className="text-[#777]">Current: <span className="font-mono">{entry.currentValue ?? "<unset>"}</span></div></div>)}</div>}</div></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><FileText className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Description & Identity</p></div><div className="p-4 space-y-4"><div><label className="block text-[10px] text-[#666] mb-1">Description</label><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4]" /></div><div><label className="block text-[10px] text-[#666] mb-2">Icon</label><div className="grid grid-cols-5 sm:grid-cols-10 gap-2">{ICON_OPTIONS.map((emoji) => <button key={emoji} onClick={() => setIcon(emoji)} className={cn("h-10 rounded-lg border text-lg transition-colors", icon === emoji ? "border-[#0078D4] bg-[#0078D4]/15" : "border-[#2a2a2a] bg-[#0a0a0a] hover:border-[#3a3a3a]")}>{emoji}</button>)}</div></div><div><label className="block text-[10px] text-[#666] mb-1">Tags</label><input value={tagsStr} onChange={(event) => setTagsStr(event.target.value)} placeholder="survival, friends, modded" className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /></div><div><label className="block text-[10px] text-[#666] mb-1">Groups</label><input value={groupsStr} onChange={(event) => setGroupsStr(event.target.value)} placeholder="production, testing, friends" className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /></div><button onClick={saveIdentity} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Save identity</button></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Package className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Image & Deployment</p></div><div className="p-4 space-y-4"><div><label className="block text-[10px] text-[#666] mb-1">Image</label><div className="flex gap-2"><input value={image} onChange={(event) => setImage(event.target.value)} className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><button onClick={saveImage} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Save image</button></div></div><div className="grid md:grid-cols-2 gap-3"><div><label className="block text-[10px] text-[#666] mb-1">Image pull policy</label><div className="flex gap-2"><select value={imagePullPolicy} onChange={(event) => setImagePullPolicy(event.target.value)} className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"><option value="Always">Always</option><option value="IfNotPresent">IfNotPresent</option><option value="Never">Never</option></select><button onClick={savePullPolicy} className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]">Save</button></div></div><div><label className="block text-[10px] text-[#666] mb-1">Deployment strategy</label><div className="flex gap-2"><select value={deploymentStrategy} onChange={(event) => setDeploymentStrategy(event.target.value)} className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"><option value="RollingUpdate">RollingUpdate</option><option value="Recreate">Recreate</option></select><button onClick={saveStrategy} className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]">Save</button></div></div></div><div className="flex flex-wrap gap-2"><button onClick={rollbackDeployment} className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] hover:bg-[#222]">Rollback</button><button onClick={viewYaml} className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] hover:bg-[#222]">View Raw YAML</button></div></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Wifi className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Service Ports</p></div><div className="p-4 space-y-3"><div className="space-y-2">{servicePorts.map((port) => <div key={port.id} className="grid grid-cols-[1fr_110px_110px_110px_auto] gap-2 items-center"><input value={port.name} onChange={(event) => updatePort(port.id, { name: event.target.value })} placeholder="name" className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><input type="number" min={1} value={port.port} onChange={(event) => updatePort(port.id, { port: Math.max(1, parseInt(event.target.value, 10) || 1) })} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><input type="number" min={1} value={port.targetPort} onChange={(event) => updatePort(port.id, { targetPort: Math.max(1, parseInt(event.target.value, 10) || 1) })} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><select value={port.protocol} onChange={(event) => updatePort(port.id, { protocol: event.target.value })} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"><option value="TCP">TCP</option><option value="UDP">UDP</option></select><button onClick={() => removePortRow(port.id)} disabled={servicePorts.length <= 1} className="p-2 rounded-lg border border-[#2a2a2a] text-[#777] hover:text-red-300 disabled:opacity-40">✕</button></div>)}</div><div className="flex gap-2"><button onClick={addPortRow} className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" />Add port</button><button onClick={savePorts} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Save</button></div></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Clock className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Scheduled Action</p></div><div className="p-4 space-y-3">{server.scheduledAction && server.scheduledTime && <p className="text-xs text-[#888]">Current schedule: <span className="text-[#f2f2f2]">{server.scheduledAction}</span> @ {new Date(server.scheduledTime).toLocaleString()}</p>}<p className="text-[11px] text-[#666]">Scheduled actions require the platform to be running so the controller can apply them.</p><div className="grid md:grid-cols-[200px_1fr_auto] gap-2"><select value={scheduledAction} onChange={(event) => setScheduledAction(event.target.value)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"><option value="none">None</option><option value="stop">Stop</option><option value="restart">Restart</option></select><input type="datetime-local" value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><button onClick={saveScheduledAction} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Save</button></div></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><HardDrive className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">PVC Snapshots</p></div><div className="p-4 space-y-3">{!isLonghornPvc ? <p className="text-xs text-[#666]">Snapshots are available for Longhorn-backed PVCs.</p> : <><div className="flex items-center justify-between gap-2"><p className="text-xs text-[#888]">Create CSI snapshots for {server.pvc?.name ?? "this PVC"}.</p><button onClick={createSnapshot} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Create Snapshot</button></div><div className="space-y-2">{(snapshotsData?.snapshots ?? []).length === 0 ? <p className="text-xs text-[#555]">{snapshotsLoading ? "Loading snapshots..." : "No snapshots found."}</p> : (snapshotsData?.snapshots ?? []).map((snapshot) => <div key={snapshot.metadata?.name} className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-mono text-[#f2f2f2]">{snapshot.metadata?.name}</span><span className={cn("px-2 py-0.5 rounded-full border text-[10px]", snapshot.status?.readyToUse ? "border-green-500/30 bg-green-500/10 text-green-300" : "border-yellow-500/30 bg-yellow-500/10 text-yellow-300")}>{snapshot.status?.readyToUse ? "Ready" : "Pending"}</span></div><p className="text-[#666] mt-1">{snapshot.metadata?.creationTimestamp ? new Date(snapshot.metadata.creationTimestamp).toLocaleString() : "Waiting for controller"}</p></div>)}</div></>}</div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Terminal className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Saved Quick Commands</p></div><div className="p-4 space-y-4"><div className="space-y-2">{savedCommands.length === 0 ? <p className="text-xs text-[#555]">No saved commands yet.</p> : savedCommands.map((entry) => <div key={`${entry.id ?? entry.label}-${entry.command}`} className="flex items-center gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm"><div className="flex-1 min-w-0"><p className="text-[#f2f2f2]">{entry.label}</p><p className="text-xs text-[#777] font-mono truncate">{entry.command}</p></div><button onClick={() => deleteQuickCommand(entry)} className="text-xs text-red-300 hover:text-red-200">Delete</button></div>)}</div><div className="grid md:grid-cols-[180px_1fr_auto] gap-2"><input value={commandLabel} onChange={(event) => setCommandLabel(event.target.value)} placeholder="Label" className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><input value={commandText} onChange={(event) => setCommandText(event.target.value)} placeholder="Command" className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]" /><button onClick={saveQuickCommand} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Save</button></div></div></div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden"><div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]"><Download className="w-3.5 h-3.5 text-[#555]" /><p className="text-xs font-medium text-[#888] uppercase tracking-wide">Server Export</p></div><div className="p-4"><button onClick={exportServer} className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs">Export Config</button></div></div>

      <ServerRbacPanel serverName={name} />

      <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden"><div className="px-4 py-3 border-b border-red-500/20"><p className="text-xs font-medium text-red-400/80 uppercase tracking-wide">Danger Zone</p></div><div className="p-4 flex items-center justify-between gap-4"><div><p className="text-sm text-[#f2f2f2]">Delete this server</p><p className="text-xs text-[#666] mt-0.5">Permanently removes the deployment and all data. This cannot be undone.</p></div><button onClick={async () => { if (!confirm(`Permanently delete ${name} and all its data? This cannot be undone.`)) return; try { await fetchJson(`/api/game-hub/servers/${name}`, { method: "DELETE" }); toast.success(`${name} deleted`); window.location.href = "/game-hub"; } catch (error) { toast.error(String(error)); } }} className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium transition-colors"><Trash2 className="w-3.5 h-3.5" /> Delete</button></div></div>

      <AnimatePresence>{yamlOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"><motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} className="w-full max-w-5xl bg-[#111] border border-[#2a2a2a] rounded-xl overflow-hidden shadow-2xl"><div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]"><div><p className="text-sm font-medium text-[#f2f2f2]">Deployment YAML</p><p className="text-xs text-[#666]">Read-only deployment manifest</p></div><div className="flex items-center gap-2"><button onClick={() => { navigator.clipboard.writeText(yamlContent); toast.success("Copied"); }} className="px-3 py-1.5 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]">Copy</button><button onClick={() => setYamlOpen(false)} className="p-2 text-[#777] hover:text-white"><X className="w-4 h-4" /></button></div></div><div className="h-[70vh]">{yamlLoading ? <div className="h-full flex items-center justify-center"><Loader2 className="w-5 h-5 animate-spin text-[#0078D4]" /></div> : <MonacoEditor height="100%" language="yaml" value={yamlContent} theme="vs-dark" options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, wordWrap: "on", scrollBeyondLastLine: false, padding: { top: 8 } }} />}</div></motion.div></div>}</AnimatePresence>
    </div>
  );
}


export default function ServerDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: server, isLoading, error, refetch } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () => fetchJson<ServerDetail>(`/api/game-hub/servers/${name}`),
    refetchInterval: 10000,
    retry: 2,
  });

  async function doAction(action: string) {
    setActionLoading(action);
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      toast.success(`${action} successful`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setActionLoading(null);
    }
  }

  const status = server?.maintenanceMode ? "maintenance" : server?.readyReplicas && server.readyReplicas > 0 ? "running" : (server?.replicas ?? 0) > 0 ? "starting" : "stopped";
  const mountPath = server?.egg?.mountPath ?? "/data";
  const statusDot = { running: "bg-green-400", starting: "bg-yellow-400 animate-pulse", maintenance: "bg-yellow-400", stopped: "bg-[#444]" }[status];
  const statusText = { running: "text-green-400", starting: "text-yellow-400", maintenance: "text-yellow-400", stopped: "text-[#666]" }[status];
  const connectionInfo = server?.nodeIp && server?.nodePort ? `${server.nodeIp}:${server.nodePort}` : server?.nodePort ? `Port ${server.nodePort}` : server?.port ? `Port ${server.port}` : "";

  useEffect(() => {
    if (typeof document === "undefined") return;
    const prefix = status === "running" ? "🟢" : status === "starting" ? "🟡" : status === "maintenance" ? "🟠" : "⚪";
    document.title = `${prefix} ${name} • InfraWeaver`;
    return () => {
      document.title = "InfraWeaver";
    };
  }, [name, status]);

  const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "console", label: "Console", icon: Terminal },
    ...(status !== "stopped" ? [{ id: "players" as const, label: "Players", icon: Users }] : []),
    { id: "files", label: "Files", icon: FolderOpen },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="space-y-0 pb-2">
      <div className="sticky top-0 z-10 bg-[#0e0e0e]/95 backdrop-blur-sm border-b border-[#1e1e1e] -mx-4 px-4 pb-0 pt-0">
        <div className="flex items-center gap-1 px-1 pt-2 text-[10px] text-[#666] overflow-x-auto scrollbar-none whitespace-nowrap">
          <Link href="/game-hub" className="hover:text-white">Game Hub</Link>
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="text-[#9e9e9e] truncate">{name}</span>
        </div>
        <div className="flex items-center gap-2 py-3">
          <Link href="/game-hub" className="p-1.5 rounded-lg text-[#555] hover:text-[#9e9e9e] hover:bg-[#1e1e1e] transition-colors flex-shrink-0">
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <span className="text-xl flex-shrink-0">{server?.icon ?? "🎮"}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-[#f2f2f2] truncate">{name}</h1>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className={cn("w-2 h-2 rounded-full flex-shrink-0", statusDot)} />
                <span className={cn("text-xs capitalize hidden sm:block", statusText)}>{status}</span>
              </div>
            </div>
            <p className="text-[10px] text-[#555]">{server?.description || `${server?.gameType?.replace(/-/g, " ") ?? "Game"} Server`}</p>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
              {server?.imageVersion && <span className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-0.5 text-[#9e9e9e]">Version {server.imageVersion}</span>}
              {server && !server.imagePinned && <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">Using latest tag</span>}
              {(server?.groups ?? []).map((group) => <span key={group} className="rounded-full border border-[#0078D4]/20 bg-[#0078D4]/10 px-2 py-0.5 text-[#7cc2ff]">{group}</span>)}
            </div>
            {server?.podStartTime && <p className="text-[10px] text-[#4db3ff] mt-0.5">Last restart {timeAgo(server.podStartTime)}</p>}
            {status === "stopped" && <p className="text-[10px] text-amber-300 mt-0.5">Server is stopped. Use Start to bring it online.</p>}
          </div>
          {server && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {connectionInfo && (
                <button onClick={() => { navigator.clipboard.writeText(connectionInfo); toast.success("Connection info copied"); }} title={connectionInfo} className="px-2 py-2 min-h-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg text-xs transition-colors max-w-[140px] truncate">
                  {connectionInfo}
                </button>
              )}
              <button onClick={async () => {
                try {
                  await fetchJson(`/api/game-hub/servers/${name}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "set-maintenance", enabled: !server.maintenanceMode }),
                  });
                  toast.success(server.maintenanceMode ? "Maintenance mode disabled" : "Maintenance mode enabled");
                  queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
                  queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
                } catch (error) {
                  toast.error(String(error));
                }
              }} className={cn("px-3 py-2 min-h-[38px] rounded-lg text-xs transition-colors border", server.maintenanceMode ? "bg-yellow-500/20 border-yellow-500/30 text-yellow-200" : "bg-[#1a1a1a] border-[#2a2a2a] hover:bg-[#222] text-[#888]")}>Maintenance</button>
              <button onClick={async () => {
                const newName = prompt("Clone server as", `${name}-copy`);
                if (!newName) return;
                try {
                  await fetchJson("/api/game-hub/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clone", source: name, newName }) });
                  toast.success("Clone started");
                  queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
                } catch (error) {
                  toast.error(String(error));
                }
              }} className="px-3 py-2 min-h-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg text-xs transition-colors">Clone</button>
              {status === "stopped" ? (
                <button onClick={() => doAction("start")} disabled={!!actionLoading} className="flex items-center gap-1.5 px-3 py-2 min-h-[38px] bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium disabled:opacity-50 touch-manipulation">
                  {actionLoading === "start" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start
                </button>
              ) : (
                <>
                  <button onClick={() => doAction("restart")} disabled={!!actionLoading} title="Quick restart" className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                    {actionLoading === "restart" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => doAction("stop")} disabled={!!actionLoading} title="Stop" className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center">
                    {actionLoading === "stop" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-0 overflow-x-auto scrollbar-none touch-pan-x pb-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setActiveTab(id)} className={cn("flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap flex-shrink-0 touch-manipulation", activeTab === id ? "border-[#0078D4] text-[#0078D4] bg-[#0078D4]/5" : "border-transparent text-[#555] hover:text-[#888]")}>
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-4">
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
            <p className="text-xs text-[#555]">Loading server details…</p>
          </div>
        )}

        {error && !isLoading && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-300">Could not load server details</p>
              <p className="text-xs text-red-400/80 mt-1 font-mono">{String(error)}</p>
              <button onClick={() => refetch()} className="mt-3 flex items-center gap-1.5 text-xs text-red-300 hover:underline"><RefreshCw className="w-3 h-3" /> Retry</button>
            </div>
          </div>
        )}

        {server && !isLoading && (
          <AnimatePresence mode="wait">
            <motion.div key={activeTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
              {activeTab === "dashboard" && <DashboardTab server={server} name={name} />}
              {activeTab === "console" && <ConsoleTab name={name} status={status} server={server} />}
              {activeTab === "players" && <PlayersTab name={name} server={server} />}
              {activeTab === "files" && <FilesTab name={name} status={status} mountPath={mountPath} />}
              {activeTab === "activity" && <ActivityTab name={name} />}
              {activeTab === "settings" && <SettingsTab name={name} server={server} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
