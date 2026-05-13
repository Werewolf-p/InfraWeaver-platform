"use client";

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Square,
  RotateCcw,
  Loader2,
  Terminal,
  Settings,
  FolderOpen,
  Activity,
  File,
  Folder,
  Save,
  Trash2,
  RefreshCw,
  Copy,
  ArrowUp,
  Send,
  Circle,
  AlertTriangle,
  Cpu,
  LayoutDashboard,
  Shield,
  Wifi,
  Layers,
  Download,
  FileText,
  Users,
  Search,
  Clock,
  Package,
  Plus,
  X,
  HardDrive,
  Wrench,
} from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { getEggForGameType } from "@/lib/game-eggs";
import { toast } from "sonner";
import Link from "next/link";
// Note: previously used Monaco editor; replaced with styled <textarea> + <pre>
// for instant load + no CDN dependency on Monaco worker scripts.
import { DashboardTab as DashboardTabFeature } from "@/components/game-hub/server-detail/dashboard-tab";
import { PlayersTab as PlayersTabFeature } from "@/components/game-hub/server-detail/players-tab";
import { ActivityTab as ActivityTabFeature } from "@/components/game-hub/server-detail/activity-tab";
import type {
  FileEntry,
  PowerSchedule,
  SavedCommand,
  ServerDetail,
} from "@/components/game-hub/server-detail/types";
import { fetchJson } from "@/components/game-hub/server-detail/utils";

// Note: previously used Monaco editor; replaced with styled <textarea> + <pre>
// for instant load + no CDN dependency on Monaco worker scripts.

type TabId =
  | "dashboard"
  | "console"
  | "players"
  | "files"
  | "settings"
  | "activity";
type RuntimeSavedCommand = SavedCommand & {
  id?: string;
  cmd?: string;
  command?: string;
  color?: string;
  description?: string;
};
type RuntimeQuickCommand = {
  label: string;
  command?: string;
  cmd?: string;
  description?: string;
  color?: string;
};
type EditablePort = {
  id: string;
  name: string;
  port: number;
  targetPort: number;
  protocol: string;
};

const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s*/;
const CONSOLE_PREFS_KEY = "infraweaver:console-prefs";
const CONSOLE_HISTORY_KEY = "infraweaver:console-history";
const RECENT_FILES_KEY = "infraweaver:recent-files";
const ICON_OPTIONS = [
  "🎮",
  "🕹️",
  "🎯",
  "🏆",
  "🎲",
  "🎸",
  "🔥",
  "💥",
  "⚔️",
  "🛡️",
  "🌍",
  "🌟",
  "💎",
  "🚀",
  "🏰",
  "🎪",
  "🎭",
  "🎬",
  "🎤",
  "🎵",
];
const SCHEDULE_DAY_OPTIONS = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
] as const;
const ALL_SCHEDULE_DAYS = SCHEDULE_DAY_OPTIONS.map((entry) => entry.value);

function normalizeCommandValue(entry: { command?: string; cmd?: string }) {
  return entry.command ?? entry.cmd ?? "";
}

function normalizeSavedCommands(
  entries: ServerDetail["savedCommands"] | undefined,
): RuntimeSavedCommand[] {
  return ((entries ?? []) as RuntimeSavedCommand[]).map((entry) => ({
    ...entry,
    command: normalizeCommandValue(entry),
  }));
}

function normalizeQuickCommands(
  entries:
    | Array<{ label: string; command?: string; description?: string }>
    | undefined,
): Array<{ label: string; command: string; description?: string }> {
  return ((entries ?? []) as RuntimeQuickCommand[])
    .map((entry) => ({
      label: entry.label,
      command: normalizeCommandValue(entry),
      description: entry.description,
    }))
    .filter((entry) => entry.command.trim().length > 0);
}

function readConsolePrefs() {
  if (typeof window === "undefined")
    return {} as Partial<{
      autoScroll: boolean;
      showTimestamps: boolean;
      wordWrap: boolean;
      levelFilter: "all" | "error" | "warn" | "info";
      regexMode: boolean;
    }>;
  try {
    return JSON.parse(sessionStorage.getItem(CONSOLE_PREFS_KEY) ?? "{}");
  } catch {
    return {} as Partial<{
      autoScroll: boolean;
      showTimestamps: boolean;
      wordWrap: boolean;
      levelFilter: "all" | "error" | "warn" | "info";
      regexMode: boolean;
    }>;
  }
}

function readConsoleHistory(name: string) {
  if (typeof window === "undefined") return [] as string[];
  try {
    const stored = JSON.parse(
      localStorage.getItem(`${CONSOLE_HISTORY_KEY}:${name}`) ?? "[]",
    ) as string[];
    return stored.filter((entry) => typeof entry === "string").slice(0, 50);
  } catch {
    return [] as string[];
  }
}

function readRecentFiles(name: string) {
  if (typeof window === "undefined") return [] as string[];
  try {
    return JSON.parse(
      localStorage.getItem(`${RECENT_FILES_KEY}:${name}`) ?? "[]",
    ) as string[];
  } catch {
    return [] as string[];
  }
}

function downloadTextFile(
  filename: string,
  content: string,
  type = "text/plain",
) {
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

function getDefaultScheduleTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function buildSchedulePayload(
  enabled: boolean,
  time: string,
  days: string[],
  timezone: string,
): PowerSchedule | null {
  if (!enabled) return null;
  return {
    time,
    days: days.length > 0 ? days : ALL_SCHEDULE_DAYS,
    timezone: timezone.trim() || "UTC",
  };
}

function stringifyEnv(env: ServerDetail["env"]) {
  return env.map((entry) => `${entry.name}=${entry.value ?? ""}`).join("\n");
}

function countContentLines(value: string | null) {
  if (value === null) return 0;
  if (!value.length) return 1;
  return value.split(/\r\n|\r|\n/).length;
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

type DiffLine = {
  type: "context" | "added" | "removed";
  value: string;
  key: string;
};

function splitDiffLines(value: string) {
  if (!value.length) return [] as string[];
  return value.split(/\r\n|\r|\n/);
}

function buildUnifiedDiff(original: string, updated: string): DiffLine[] {
  const before = splitDiffLines(original);
  const after = splitDiffLines(updated);
  const lcs = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        before[i] === after[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      diff.push({ type: "context", value: before[i], key: `context-${i}-${j}` });
      i += 1;
      j += 1;
      continue;
    }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      diff.push({ type: "removed", value: before[i], key: `removed-${i}-${j}` });
      i += 1;
    } else {
      diff.push({ type: "added", value: after[j], key: `added-${i}-${j}` });
      j += 1;
    }
  }
  while (i < before.length) {
    diff.push({ type: "removed", value: before[i], key: `removed-tail-${i}` });
    i += 1;
  }
  while (j < after.length) {
    diff.push({ type: "added", value: after[j], key: `added-tail-${j}` });
    j += 1;
  }
  return diff;
}

function DashboardTab({
  server,
  name,
}: {
  server: ServerDetail;
  name: string;
}) {
  return <DashboardTabFeature name={name} server={server} />;
}

function ConsoleTab({
  name,
  status,
  server,
}: {
  name: string;
  status: string;
  server: ServerDetail;
}) {
  const queryClient = useQueryClient();
  const [logLines, setLogLines] = useState<
    Array<{ type: string; line: string; id: number; timestamp?: string | null }>
  >([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podLabel, setPodLabel] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [history, setHistory] = useState<string[]>(() =>
    readConsoleHistory(name),
  );
  const [reconnectBanner, setReconnectBanner] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);
  const [autoScroll, setAutoScroll] = useState(
    () => readConsolePrefs().autoScroll !== false,
  );
  const [showTimestamps, setShowTimestamps] = useState(
    () => readConsolePrefs().showTimestamps !== false,
  );
  const [wordWrap, setWordWrap] = useState(
    () => readConsolePrefs().wordWrap !== false,
  );
  const [levelFilter, setLevelFilter] = useState<
    "all" | "error" | "warn" | "info"
  >(
    () =>
      (readConsolePrefs().levelFilter as "all" | "error" | "warn" | "info") ??
      "all",
  );
  const [regexMode, setRegexMode] = useState(() =>
    Boolean(readConsolePrefs().regexMode),
  );
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
  const draftCommandRef = useRef("");

  const eggCommands = normalizeQuickCommands(server.egg?.quickCommands);
  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const isConnected = status !== "stopped" && connected;
  const canStartServer = server.permissions?.canStart ?? true;

  const addLine = useCallback(
    (type: string, line: string, timestamp?: string | null) => {
      setLogLines((prev) => [
        ...prev.slice(-1000),
        { type, line, timestamp, id: logIdRef.current++ },
      ]);
    },
    [],
  );

  const showBanner = useCallback(
    (message: string | null, durationMs?: number) => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
      setReconnectBanner(message);
      if (message && durationMs) {
        bannerTimeoutRef.current = setTimeout(
          () => setReconnectBanner(null),
          durationMs,
        );
      }
    },
    [],
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(
        CONSOLE_PREFS_KEY,
        JSON.stringify({
          autoScroll,
          showTimestamps,
          wordWrap,
          levelFilter,
          regexMode,
        }),
      );
    } catch {
      // ignore
    }
  }, [autoScroll, levelFilter, regexMode, showTimestamps, wordWrap]);

  useEffect(() => {
    try {
      localStorage.setItem(
        `${CONSOLE_HISTORY_KEY}:${name}`,
        JSON.stringify(history.slice(0, 50)),
      );
    } catch {
      // ignore
    }
  }, [history, name]);

  const connect = useCallback(() => {
    if (status === "stopped") return;
    if (retryRef.current) clearTimeout(retryRef.current);
    esRef.current?.close();

    const params = new URLSearchParams();
    if (lastLogTimestampRef.current)
      params.set("sinceTime", lastLogTimestampRef.current);
    else params.set("tail", "200");

    const es = new EventSource(
      `/api/game-hub/servers/${name}/logs?${params.toString()}`,
    );
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as {
          type: string;
          line?: string;
          pod?: string;
          timestamp?: string;
        };
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
          const lineTimestamp =
            msg.timestamp ??
            msg.line.match(ISO_TIMESTAMP_PREFIX)?.[0]?.trim() ??
            null;
          if (lineTimestamp) lastLogTimestampRef.current = lineTimestamp;
          const cleanLine = msg.line.replace(ISO_TIMESTAMP_PREFIX, "");
          addLine(
            msg.type === "error" ? "error" : "log",
            cleanLine || msg.line,
            lineTimestamp,
          );
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
      // Only show disconnect banner if we've been connected before AND delay is significant
      // (first two retries at 2s/4s are silent — these are normal SSE keep-alive resets)
      if (hasConnectedRef.current && delay >= 8000) {
        showBanner(
          `Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`,
        );
      }
      retryRef.current = setTimeout(() => connectRef.current(), delay);
    };
  }, [addLine, name, showBanner, status]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (status === "stopped") {
      esRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
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
    draftCommandRef.current = "";
    setHistory((prev) =>
      [trimmed, ...prev.filter((entry) => entry !== trimmed)].slice(0, 50),
    );
    addLine("input", `❯ ${trimmed}`, new Date().toISOString());
    try {
      const result = await fetchJson<{
        stdout?: string;
        stderr?: string;
        error?: string;
      }>(`/api/game-hub/servers/${name}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
      });
      if (result.error)
        addLine("error", result.error, new Date().toISOString());
      if (result.stdout)
        result.stdout
          .split("\n")
          .filter(Boolean)
          .forEach((line) => addLine("output", line, new Date().toISOString()));
      if (result.stderr)
        result.stderr
          .split("\n")
          .filter(Boolean)
          .forEach((line) => addLine("error", line, new Date().toISOString()));
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
        body: JSON.stringify({
          action: "save-command",
          command: { label: trimmed, cmd: trimmed },
        }),
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
        body: JSON.stringify({
          action: "delete-saved-command",
          commandId: entry.id,
        }),
      });
      toast.success("Saved command removed");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function startServer() {
    setStartingServer(true);
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      toast.success("Server starting");
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    } catch (error) {
      toast.error(String(error));
    } finally {
      setStartingServer(false);
    }
  }

  function clearCommandHistory() {
    setHistory([]);
    historyIdxRef.current = -1;
    draftCommandRef.current = "";
    try {
      localStorage.removeItem(`${CONSOLE_HISTORY_KEY}:${name}`);
    } catch {
      // ignore
    }
    toast.success("Command history cleared");
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      if (history.length === 0) return;
      event.preventDefault();
      if (historyIdxRef.current === -1) draftCommandRef.current = command;
      const next = Math.min(historyIdxRef.current + 1, history.length - 1);
      historyIdxRef.current = next;
      setCommand(history[next] ?? "");
    } else if (event.key === "ArrowDown") {
      if (history.length === 0 && historyIdxRef.current === -1) return;
      event.preventDefault();
      const next = Math.max(historyIdxRef.current - 1, -1);
      historyIdxRef.current = next;
      setCommand(next < 0 ? draftCommandRef.current : (history[next] ?? ""));
    }
  }

  const lineColor = (type: string) =>
    ({
      system: "text-blue-400/80",
      error: "text-red-400",
      input: "text-yellow-300",
      output: "text-cyan-300",
    })[type] ?? "text-[#ccc]";
  const detectLogLevel = useCallback((type: string, line: string) => {
    const value = line.toLowerCase();
    if (type === "error" || /\b(error|fatal|panic)\b/.test(value))
      return "error" as const;
    if (/\bwarn(ing)?\b/.test(value)) return "warn" as const;
    return "info" as const;
  }, []);
  const renderedLine = useCallback(
    (entry: { line: string; timestamp?: string | null }) => {
      if (!showTimestamps || !entry.timestamp) return entry.line;
      return `${entry.timestamp} ${entry.line}`;
    },
    [showTimestamps],
  );
  const searchRegex = useMemo(() => {
    if (!regexMode || !searchTerm.trim()) return null;
    try {
      return new RegExp(searchTerm, "i");
    } catch {
      return null;
    }
  }, [regexMode, searchTerm]);
  const visibleLogLines = useMemo(
    () =>
      logLines.filter((entry) => {
        if (levelFilter === "all") return true;
        return detectLogLevel(entry.type, entry.line) === levelFilter;
      }),
    [detectLogLevel, levelFilter, logLines],
  );
  const lineMatchesSearch = useCallback(
    (entry: { line: string; timestamp?: string | null }) => {
      if (!searchTerm.trim()) return false;
      const value = renderedLine(entry);
      return searchRegex
        ? searchRegex.test(value)
        : value.toLowerCase().includes(searchTerm.toLowerCase());
    },
    [renderedLine, searchRegex, searchTerm],
  );
  const matches = searchTerm
    ? visibleLogLines
        .filter((line) => lineMatchesSearch(line))
        .map((line) => line.id)
    : [];
  const jumpToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchIndex + direction + matches.length) % matches.length;
    setMatchIndex(next);
    lineRefs.current[matches[next]]?.scrollIntoView({ block: "center" });
  };
  const handleConsoleScroll = () => {
    const element = consoleRef.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setAutoScroll(nearBottom);
  };

  return (
    <div
      className="flex flex-col rounded-xl border border-[#2a2a2a] bg-[#0a0a0a] overflow-hidden"
      style={{ height: "calc(100vh - 280px)", minHeight: "360px" }}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-[#111] border-b border-[#1e1e1e] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Circle
            className={cn(
              "w-2 h-2",
              isConnected
                ? "fill-green-400 text-green-400"
                : "fill-[#444] text-[#444]",
            )}
          />
          <span
            className={cn(
              "text-xs truncate",
              isConnected ? "text-green-400" : "text-[#555]",
            )}
          >
            {isConnected
              ? podLabel
              : status === "stopped"
                ? "Server stopped"
                : "Connecting…"}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!isConnected && status !== "stopped" && (
            <button
              onClick={() => {
                retryCountRef.current = 0;
                connectRef.current();
              }}
              className="text-xs text-[#0078D4] hover:underline"
            >
              Reconnect
            </button>
          )}
          <button
            onClick={() => setAutoScroll((value) => !value)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] transition-colors",
              autoScroll
                ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
                : "border-[#2a2a2a] text-[#777]",
            )}
          >
            {autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
          </button>
          <button
            onClick={() => setShowTimestamps((value) => !value)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] transition-colors",
              showTimestamps
                ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
                : "border-[#2a2a2a] text-[#777]",
            )}
          >
            Timestamps
          </button>
          <button
            onClick={() => setWordWrap((value) => !value)}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] transition-colors",
              wordWrap
                ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
                : "border-[#2a2a2a] text-[#777]",
            )}
          >
            Wrap
          </button>
          <button
            onClick={() => {
              setSearchOpen((prev) => !prev);
              setTimeout(() => searchRef.current?.focus(), 0);
            }}
            className="p-1.5 text-[#444] hover:text-[#888] hover:bg-[#1e1e1e] rounded transition-colors"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <div className="flex items-center gap-1">
            {[
              {
                icon: RefreshCw,
                label: "Clear",
                action: () => setLogLines([]),
              },
              {
                icon: Copy,
                label: "Copy all",
                action: () => {
                  navigator.clipboard.writeText(
                    visibleLogLines
                      .map((line) => renderedLine(line))
                      .join("\n"),
                  );
                  toast.success("Copied");
                },
              },
              {
                icon: Download,
                label: "Download logs",
                action: () =>
                  downloadTextFile(
                    `${name}-console-${new Date().toISOString().slice(0, 10)}.txt`,
                    visibleLogLines
                      .map((line) => renderedLine(line))
                      .join("\n"),
                  ),
              },
            ].map(({ icon: Icon, label, action }) => (
              <button
                key={label}
                onClick={action}
                title={label}
                className="p-1.5 text-[#444] hover:text-[#888] hover:bg-[#1e1e1e] rounded transition-colors"
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[#1e1e1e] bg-[#101010]">
          <Search className="w-3.5 h-3.5 text-[#666]" />
          <input
            ref={searchRef}
            value={searchTerm}
            onChange={(event) => {
              setSearchTerm(event.target.value);
              setMatchIndex(0);
            }}
            placeholder={
              regexMode ? "Search console regex..." : "Search console..."
            }
            className="min-w-[180px] flex-1 bg-transparent text-sm text-[#f2f2f2] outline-none"
          />
          <select
            value={levelFilter}
            onChange={(event) =>
              setLevelFilter(
                event.target.value as "all" | "error" | "warn" | "info",
              )
            }
            className="rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1 text-[10px] text-[#bbb] focus:outline-none"
          >
            <option value="all">All levels</option>
            <option value="error">ERROR</option>
            <option value="warn">WARN</option>
            <option value="info">INFO</option>
          </select>
          <button
            onClick={() => setRegexMode((value) => !value)}
            className={cn(
              "rounded border px-2 py-1 text-[10px]",
              regexMode
                ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
                : "border-[#2a2a2a] text-[#777]",
            )}
          >
            Regex
          </button>
          <span className="text-xs text-[#666]">
            {matches.length === 0 ? "0" : `${matchIndex + 1}/${matches.length}`}
          </span>
          <button
            onClick={() => jumpToMatch(-1)}
            className="text-xs text-[#0078D4]"
          >
            Prev
          </button>
          <button
            onClick={() => jumpToMatch(1)}
            className="text-xs text-[#0078D4]"
          >
            Next
          </button>
          <button
            onClick={() => setSearchOpen(false)}
            className="text-xs text-[#666]"
          >
            Esc
          </button>
          {regexMode && searchTerm && !searchRegex && (
            <span className="text-[10px] text-red-300">Invalid regex</span>
          )}
        </div>
      )}

      {reconnectBanner && status !== "stopped" && (
        <div className="px-4 py-1.5 border-b border-[#1e1e1e] bg-[#111827] text-[11px] text-[#93c5fd]">
          {reconnectBanner}
        </div>
      )}

      <div
        ref={consoleRef}
        onScroll={handleConsoleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto p-4 font-mono text-xs leading-[1.7] overscroll-contain select-text"
      >
        {status === "stopped" ? (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-md rounded-2xl border border-[#2a2a2a] bg-[#111] px-6 py-10 text-center shadow-[0_0_40px_rgba(0,0,0,0.35)]">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[#2a2a2a] bg-[#0d0d0d] text-[#666]">
                <Square className="h-8 w-8" />
              </div>
              <h3 className="text-2xl font-semibold text-[#f2f2f2]">
                Server Stopped
              </h3>
              <p className="mt-2 text-sm text-[#666]">
                Start the server to stream logs and run commands.
              </p>
              {canStartServer ? (
                <button
                  onClick={() => void startServer()}
                  disabled={startingServer}
                  className="mx-auto mt-6 inline-flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/20 px-4 py-2.5 text-sm font-medium text-green-200 transition-colors hover:bg-green-500/30 disabled:opacity-50"
                >
                  {startingServer ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Start Server
                </button>
              ) : (
                <p className="mt-6 text-xs text-[#555]">
                  You do not have permission to start this server.
                </p>
              )}
            </div>
          </div>
        ) : visibleLogLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#444] pt-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {logLines.length === 0
                ? "Connecting to log stream…"
                : "No logs match the current filters."}
            </span>
          </div>
        ) : (
          visibleLogLines.map((entry) => (
            <div
              key={entry.id}
              ref={(element) => {
                lineRefs.current[entry.id] = element;
              }}
              className={cn(
                wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                "px-1 rounded min-w-fit transition-opacity",
                lineColor(entry.type),
                searchTerm && !matches.includes(entry.id) && "opacity-35",
                matches.includes(entry.id) && "bg-yellow-400/10",
                matches[matchIndex] === entry.id && "ring-1 ring-yellow-400/40",
              )}
            >
              {renderedLine(entry)}
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {isConnected && (eggCommands.length > 0 || savedCommands.length > 0) && (
        <div className="flex-shrink-0 px-3 py-2 border-t border-[#1a1a1a] bg-[#0d0d0d] space-y-3">
          {eggCommands.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">
                Quick Commands
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {eggCommands.map((entry) => (
                  <button
                    key={`${entry.label}-${entry.command}`}
                    onClick={() => {
                      setCommand(entry.command);
                      inputRef.current?.focus();
                    }}
                    className="px-2.5 py-1 rounded text-[10px] bg-[#1a1a1a] hover:bg-[#252525] border border-[#2a2a2a] text-[#777] hover:text-[#ccc] transition-colors"
                  >
                    {entry.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {savedCommands.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">
                Saved Commands
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {savedCommands.map((entry) => (
                  <div
                    key={`${entry.id ?? entry.label}-${entry.command}`}
                    className="flex items-center rounded border border-[#2a2a2a] bg-[#1a1a1a] overflow-hidden"
                  >
                    <button
                      onClick={() => {
                        setCommand(entry.command ?? "");
                        inputRef.current?.focus();
                      }}
                      className="px-2.5 py-1 text-[10px] text-[#777] hover:text-[#ccc] hover:bg-[#252525] transition-colors"
                    >
                      {entry.label}
                    </button>
                    <button
                      onClick={() => deleteSavedCommand(entry)}
                      className="px-1.5 py-1 text-[10px] text-[#555] hover:text-red-300 hover:bg-red-500/10 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-shrink-0 border-t border-[#1a1a1a] p-2 bg-[#0d0d0d]">
        <form onSubmit={sendCommand} className="flex gap-2">
          <div
            className={cn(
              "flex-1 flex items-center gap-2 bg-[#111] border rounded-lg px-3 min-h-[46px]",
              isConnected
                ? "border-[#2a2a2a] focus-within:border-[#0078D4]"
                : "border-[#1a1a1a] opacity-50",
            )}
          >
            <span className="text-green-500 font-mono text-sm select-none flex-shrink-0">
              ❯
            </span>
            <input
              ref={inputRef}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isConnected
                  ? "Enter command… (↑↓ history)"
                  : "Waiting for connection…"
              }
              disabled={!isConnected || sending}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent text-[16px] leading-none font-mono text-[#f0f0f0] outline-none placeholder:text-[#333] disabled:cursor-not-allowed py-1"
            />
          </div>
          <button
            type="button"
            onClick={saveCurrentCommand}
            disabled={!command.trim()}
            className="px-3 min-h-[46px] bg-[#1a1a1a] hover:bg-[#252525] disabled:opacity-40 text-[#cfcfcf] rounded-lg transition-colors text-xs font-medium flex-shrink-0"
          >
            Save
          </button>
          <button
            type="button"
            onClick={clearCommandHistory}
            disabled={history.length === 0}
            className="px-3 min-h-[46px] bg-[#1a1a1a] hover:bg-[#252525] disabled:opacity-40 text-[#9e9e9e] rounded-lg transition-colors text-xs font-medium flex-shrink-0"
          >
            Clear History
          </button>
          <button
            type="submit"
            disabled={!isConnected || sending || !command.trim()}
            className="flex items-center justify-center w-[50px] min-h-[46px] bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-25 text-white rounded-lg transition-colors touch-manipulation flex-shrink-0"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
        <p className="text-[10px] text-[#2a2a2a] mt-1.5 px-1">
          Universal console • ↑↓ for history
        </p>
      </div>
    </div>
  );
}

function PlayersTab({ name, server }: { name: string; server: ServerDetail }) {
  return <PlayersTabFeature name={name} server={server} />;
}

function FilesTab({
  name,
  status,
  mountPath,
}: {
  name: string;
  status: string;
  mountPath: string;
}) {
  const [currentPath, setCurrentPath] = useState(mountPath);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  const [fileContent, setFileContent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);
  const [pathHistory, setPathHistory] = useState<string[]>([mountPath]);
  const [mobilePane, setMobilePane] = useState<"files" | "editor">("files");
  const [fileSearch, setFileSearch] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "size" | "modified">("name");
  const [recentFiles, setRecentFiles] = useState<string[]>(() =>
    readRecentFiles(name),
  );
  const originalContentRef = useRef<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const saveFileRef = useRef<() => Promise<void>>(async () => undefined);

  const {
    data: listing,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["game-hub", "files", name, currentPath],
    queryFn: () =>
      fetchJson<{ files: FileEntry[] }>(
        `/api/game-hub/servers/${name}/files?path=${encodeURIComponent(currentPath)}`,
      ),
    enabled: status !== "stopped",
    retry: 1,
  });

  const fileExt = selectedFile?.name.split(".").pop()?.toLowerCase() ?? "";
  const editorLang =
    (
      {
        json: "json",
        yaml: "yaml",
        yml: "yaml",
        properties: "ini",
        conf: "ini",
        cfg: "ini",
        log: "plaintext",
        txt: "plaintext",
        sh: "shell",
        py: "python",
        js: "javascript",
        ts: "typescript",
        xml: "xml",
        toml: "toml",
      } as Record<string, string>
    )[fileExt] ?? "plaintext";
  const isImageFile = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
    fileExt,
  );
  const isArchiveFile = /\.(tar\.gz|tgz|zip)$/i.test(selectedFile?.name ?? "");
  const isDirty = Boolean(
    selectedFile &&
      fileContent !== null &&
      fileContent !== originalContentRef.current,
  );
  const fileLineCount = countContentLines(fileContent);
  const diffLines = useMemo(
    () => buildUnifiedDiff(originalContentRef.current ?? "", fileContent ?? ""),
    [fileContent, selectedFile?.path],
  );
  const changedDiffLines = diffLines.filter((line) => line.type !== "context").length;

  useEffect(() => {
    try {
      localStorage.setItem(
        `${RECENT_FILES_KEY}:${name}`,
        JSON.stringify(recentFiles.slice(0, 5)),
      );
    } catch {
      // ignore
    }
  }, [name, recentFiles]);

  useEffect(() => {
    const handleSaveHotkey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "s" &&
        selectedFile
      ) {
        event.preventDefault();
        if (!saving && !loadingContent && isDirty) setDiffOpen(true);
      }
    };
    window.addEventListener("keydown", handleSaveHotkey);
    return () => window.removeEventListener("keydown", handleSaveHotkey);
  }, [isDirty, loadingContent, saving, selectedFile]);

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
    if (
      isDirty &&
      !confirm(
        `Discard unsaved changes in ${selectedFile?.name ?? "this file"}?`,
      )
    )
      return;
    if (entry.type === "directory") {
      setPathHistory((history) => [...history, entry.path]);
      setCurrentPath(entry.path);
      setDiffOpen(false);
      setSelectedFile(null);
      setFileContent(null);
      originalContentRef.current = null;
      return;
    }

    setDiffOpen(false);
    setSelectedFile(entry);
    setFileContent(null);
    originalContentRef.current = null;
    setLoadingContent(
      !["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
        entry.name.split(".").pop()?.toLowerCase() ?? "",
      ),
    );
    setMobilePane("editor");
    setRecentFiles((prev) =>
      [entry.path, ...prev.filter((item) => item !== entry.path)].slice(0, 5),
    );
    if (
      ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(
        entry.name.split(".").pop()?.toLowerCase() ?? "",
      )
    ) {
      setFileContent("");
      originalContentRef.current = "";
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await fetchJson<{ content: string }>(
        `/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`,
        { signal: controller.signal },
      );
      setFileContent(result.content);
      originalContentRef.current = result.content;
    } catch (error) {
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "File load timed out — server may be busy"
          : String(error);
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
      setDiffOpen(false);
      setSelectedFile((current) =>
        current
          ? {
              ...current,
              size: new Blob([fileContent]).size,
              modifiedAt: new Date().toISOString(),
            }
          : current,
      );
      toast.success("File saved");
      refetch();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    saveFileRef.current = saveFile;
  }, [fileContent, name, selectedFile]);

  async function deleteFile(entry: FileEntry) {
    if (!confirm(`Delete ${entry.name}?`)) return;
    try {
      await fetchJson(
        `/api/game-hub/servers/${name}/files?path=${encodeURIComponent(entry.path)}`,
        { method: "DELETE" },
      );
      toast.success(`${entry.name} deleted`);
      if (selectedFile?.path === entry.path) {
        setDiffOpen(false);
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
    setDiffOpen(false);
    setSelectedFile(null);
    setFileContent(null);
    originalContentRef.current = null;
  }

  const sortedFiles = useMemo(() => {
    const filteredFiles = (listing?.files ?? []).filter(
      (entry) =>
        !fileSearch.trim() ||
        entry.name.toLowerCase().includes(fileSearch.toLowerCase()),
    );
    return [...filteredFiles].sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      if (sortKey === "size") return b.size - a.size;
      if (sortKey === "modified")
        return (
          new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
        );
      return a.name.localeCompare(b.name);
    });
  }, [fileSearch, listing?.files, sortKey]);

  const breadcrumbParts = currentPath.split("/").filter(Boolean);
  const recentOpenFiles = recentFiles
    .map(
      (path) =>
        (listing?.files ?? []).find((entry) => entry.path === path) ??
        ({
          name: path.split("/").pop() ?? path,
          path,
          type: "file",
          size: 0,
          modifiedAt: new Date().toISOString(),
          permissions: "",
        } as FileEntry),
    )
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
          <button
            onClick={goUp}
            disabled={pathHistory.length <= 1}
            className="p-1 rounded hover:bg-[#1e1e1e] disabled:opacity-30 transition-colors flex-shrink-0"
          >
            <ArrowUp className="w-3.5 h-3.5 text-[#666]" />
          </button>
          <div className="flex-1 min-w-0 overflow-x-auto scrollbar-none">
            <div className="flex items-center gap-1.5 w-max min-w-full text-[10px] font-mono text-[#777]">
              <button
                onClick={() => {
                  setCurrentPath(mountPath);
                  setPathHistory([mountPath]);
                  setDiffOpen(false);
                  setSelectedFile(null);
                  setFileContent(null);
                  originalContentRef.current = null;
                }}
                className="rounded px-1 py-0.5 hover:bg-[#1e1e1e]"
              >
                root
              </button>
              {breadcrumbParts.map((part, index) => {
                const nextPath = `/${breadcrumbParts.slice(0, index + 1).join("/")}`;
                return (
                  <Fragment key={nextPath}>
                    <span>/</span>
                    <button
                      onClick={() => {
                        setCurrentPath(nextPath);
                        setPathHistory((history) => [
                          ...history.filter((path) => path !== nextPath),
                          nextPath,
                        ]);
                        setDiffOpen(false);
                        setSelectedFile(null);
                        setFileContent(null);
                        originalContentRef.current = null;
                      }}
                      className="rounded px-1 py-0.5 hover:bg-[#1e1e1e]"
                    >
                      {part}
                    </button>
                  </Fragment>
                );
              })}
            </div>
          </div>
          <button
            onClick={() => refetch()}
            className="p-1 rounded hover:bg-[#1e1e1e] transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-3 h-3 text-[#555]" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#555]" />
            <input
              value={fileSearch}
              onChange={(event) => setFileSearch(event.target.value)}
              placeholder="Search files…"
              className="w-full rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] py-1.5 pl-8 pr-3 text-xs text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
          </div>
          <select
            value={sortKey}
            onChange={(event) =>
              setSortKey(event.target.value as "name" | "size" | "modified")
            }
            className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-[10px] text-[#bbb] focus:outline-none"
          >
            <option value="name">Name</option>
            <option value="size">Size</option>
            <option value="modified">Modified</option>
          </select>
        </div>
      </div>
      {recentOpenFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {recentOpenFiles.map((entry) => (
            <button
              key={entry.path}
              onClick={() => void openFile(entry)}
              className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-1 text-[10px] text-[#9e9e9e] hover:text-white"
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 className="w-4 h-4 animate-spin text-[#555]" />
          </div>
        ) : sortedFiles.length === 0 ? (
          <p className="text-xs text-[#555] text-center py-6">
            {fileSearch
              ? "No files match the current search"
              : "Empty directory"}
          </p>
        ) : (
          <div
            className="p-1 max-h-[55vh] overflow-y-auto overscroll-contain"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const fileEntries = sortedFiles.filter(
                (entry) => entry.type !== "directory",
              );
              if (fileEntries.length === 0) return;
              event.preventDefault();
              const currentIndex = fileEntries.findIndex(
                (entry) => entry.path === selectedFile?.path,
              );
              const nextEntry =
                fileEntries[
                  (currentIndex + 1 + fileEntries.length) % fileEntries.length
                ];
              void openFile(nextEntry);
            }}
          >
            {sortedFiles.map((entry) => (
              <div
                key={entry.path}
                onClick={() => void openFile(entry)}
                className={cn(
                  "group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors text-xs touch-manipulation",
                  selectedFile?.path === entry.path
                    ? "bg-[rgba(0,120,212,0.2)] text-white"
                    : "hover:bg-[#1a1a1a] text-[#9e9e9e]",
                )}
              >
                {entry.type === "directory" ? (
                  <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                ) : (
                  <File className="w-3.5 h-3.5 text-[#444] flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "truncate block min-w-0",
                        fileSearch &&
                          entry.name
                            .toLowerCase()
                            .includes(fileSearch.toLowerCase()) &&
                          "text-white",
                      )}
                    >
                      {entry.name}
                    </span>
                    <span className="shrink-0 rounded border border-[#2a2a2a] bg-[#0a0a0a] px-1.5 py-0.5 text-[10px] font-mono text-[#8fb8ff]">
                      {entry.permissions || "---------"}
                    </span>
                  </div>
                  <span className="text-[10px] text-[#555]">
                    {entry.type === "directory"
                      ? "Directory"
                      : `${formatBytes(entry.size)} • ${timeAgo(entry.modifiedAt)}`}
                  </span>
                </div>
                {entry.type !== "directory" &&
                  /\.(tar\.gz|tgz|zip)$/i.test(entry.name) && (
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        void extractArchive(entry);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-[#444] hover:text-green-300 transition-all"
                      title="Extract here"
                    >
                      <Package className="w-3 h-3" />
                    </button>
                  )}
                {entry.type !== "directory" && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteFile(entry);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-[#444] hover:text-red-400 transition-all"
                  >
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
            <button
              onClick={() => setMobilePane("files")}
              className="md:hidden flex items-center gap-1 text-xs text-[#0078D4] flex-shrink-0"
            >
              ← Files
            </button>
            <div className="min-w-0 flex-1">
              <span className="text-xs text-[#555] font-mono truncate block">
                {selectedFile.path}
              </span>
              <span className="text-[10px] text-[#444]">
                {selectedFile.permissions || "---------"} •{" "}
                {formatBytes(selectedFile.size)} • Modified{" "}
                {formatDateTime(selectedFile.modifiedAt)} •{" "}
                {fileLineCount} line{fileLineCount === 1 ? "" : "s"}{" "}
                {isDirty ? "• Unsaved changes" : "• Saved"}
              </span>
            </div>
            <button
              onClick={() => {
                navigator.clipboard.writeText(fileContent ?? "");
                toast.success("Copied");
              }}
              className="p-1.5 text-[#444] hover:text-[#888] flex-shrink-0"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {isArchiveFile && (
              <button
                onClick={() => void extractArchive(selectedFile)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#252525] text-[#d4d4d4] rounded-lg text-xs font-medium flex-shrink-0"
              >
                <Package className="w-3 h-3" /> Extract
              </button>
            )}
            {!isImageFile && isDirty && (
              <button
                onClick={() => setDiffOpen(true)}
                disabled={saving || loadingContent}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#252525] disabled:opacity-50 text-[#d4d4d4] rounded-lg text-xs font-medium flex-shrink-0"
              >
                <FileText className="w-3 h-3" /> Show diff
              </button>
            )}
            {!isImageFile && (
              <button
                onClick={() => {
                  if (!isDirty) return;
                  setDiffOpen(true);
                }}
                disabled={!isDirty || saving || loadingContent}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-xs font-medium flex-shrink-0"
              >
                {saving ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Save className="w-3 h-3" />
                )}{" "}
                Save (Ctrl+S)
              </button>
            )}
          </div>
          <div
            className="rounded-xl border border-[#2a2a2a] overflow-hidden min-w-0"
            style={{ height: "60vh", minHeight: "320px" }}
          >
            {loadingContent ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-[#555]" />
              </div>
            ) : isImageFile ? (
              <div className="flex h-full items-center justify-center bg-[#0a0a0a] p-4">
                <img
                  src={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(selectedFile.path)}&download=1`}
                  alt={selectedFile.name}
                  className="max-h-full max-w-full rounded border border-[#2a2a2a] object-contain"
                />
              </div>
            ) : (
              <textarea
                value={fileContent ?? ""}
                onChange={(e) => setFileContent(e.target.value)}
                spellCheck={false}
                className="w-full h-full bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[13px] leading-[1.5] p-3 resize-none focus:outline-none border-0"
                style={{ tabSize: 2 }}
                placeholder="Empty file"
              />
            )}
          </div>
        </>
      ) : (
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#111] gap-3"
          style={{ height: "55vh", minHeight: "200px" }}
        >
          <FolderOpen className="w-10 h-10 text-[#2a2a2a]" />
          <p className="text-sm text-[#555]">Select a file to edit</p>
          <button
            onClick={() => setMobilePane("files")}
            className="md:hidden text-xs text-[#0078D4]"
          >
            Browse files →
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <AnimatePresence>
        {diffOpen && selectedFile && !isImageFile && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setDiffOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 12 }}
              transition={{ duration: 0.18 }}
              className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#2a2a2a] bg-[#0d0d0d] shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-[#1e1e1e] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-[#666]">
                      Unified diff preview
                    </p>
                    <h3 className="mt-1 text-base font-semibold text-[#f2f2f2]">
                      {selectedFile.name}
                    </h3>
                    <p className="mt-1 text-xs text-[#777]">
                      {changedDiffLines} changed line{changedDiffLines === 1 ? "" : "s"} • review before saving
                    </p>
                  </div>
                  <button
                    onClick={() => setDiffOpen(false)}
                    className="rounded-lg border border-[#2a2a2a] p-2 text-[#666] transition-colors hover:bg-[#161616] hover:text-[#d4d4d4]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="border-b border-[#1e1e1e] bg-[#101010] px-5 py-2 font-mono text-[11px] text-[#666]">
                <div>--- original</div>
                <div>+++ current</div>
              </div>
              <div className="max-h-[65vh] overflow-auto bg-[#0a0a0a] p-3 font-mono text-xs leading-6">
                {diffLines.length === 0 ? (
                  <div className="rounded-lg border border-[#1e1e1e] bg-[#111] px-4 py-6 text-center text-[#666]">
                    No changes detected.
                  </div>
                ) : (
                  diffLines.map((line) => (
                    <div
                      key={line.key}
                      className={cn(
                        "rounded-md px-3 py-0.5 whitespace-pre-wrap break-all",
                        line.type === "removed"
                          ? "bg-red-500/15 text-red-100"
                          : line.type === "added"
                            ? "bg-green-500/15 text-green-100"
                            : "text-[#8a8a8a]",
                      )}
                    >
                      <span className="mr-2 inline-block w-3 text-center text-[#666]">
                        {line.type === "removed"
                          ? "-"
                          : line.type === "added"
                            ? "+"
                            : " "}
                      </span>
                      {line.value || " "}
                    </div>
                  ))
                )}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#1e1e1e] bg-[#101010] px-5 py-4">
                <button
                  onClick={() => setDiffOpen(false)}
                  className="rounded-lg border border-[#2a2a2a] px-4 py-2 text-sm text-[#999] transition-colors hover:bg-[#161616] hover:text-[#f2f2f2]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    void saveFileRef.current();
                  }}
                  disabled={saving}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#0078D4]/40 bg-[#0078D4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0065B3] disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save anyway
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="hidden md:grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-4">
        {fileTree}
        {editorPane}
      </div>
      <div className="md:hidden space-y-3">
        <div className="flex gap-1 p-1 bg-[#111] rounded-lg border border-[#2a2a2a]">
          {(["files", "editor"] as const).map((pane) => (
            <button
              key={pane}
              onClick={() => setMobilePane(pane)}
              className={cn(
                "flex-1 py-2.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1.5",
                mobilePane === pane ? "bg-[#0078D4] text-white" : "text-[#666]",
              )}
            >
              {pane === "files" ? (
                <Folder className="w-3.5 h-3.5" />
              ) : (
                <File className="w-3.5 h-3.5" />
              )}
              {pane === "editor" && selectedFile
                ? `${selectedFile.name}${isDirty ? " *" : ""}`
                : pane === "files"
                  ? "Files"
                  : "Editor"}
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

type ServerAccessRole =
  | "game-server-admin"
  | "game-server-operator"
  | "game-server-viewer";

interface InheritedAccessAssignment {
  user: string;
  role: string;
  scope: string;
  source: "platform" | "game-hub";
}

interface ServerAccessAssignment {
  user: string;
  role: string;
}

interface ServerAccessResponse {
  inherited: InheritedAccessAssignment[];
  serverAssignments: ServerAccessAssignment[];
  availableUsers: string[];
}

const GAME_SERVER_ROLES = [
  {
    id: "game-server-admin",
    label: "game-server-admin",
    description: "Full control (start/stop/scale/console/files/settings)",
  },
  {
    id: "game-server-operator",
    label: "game-server-operator",
    description: "Console and file access only",
  },
  {
    id: "game-server-viewer",
    label: "game-server-viewer",
    description: "Read-only status/metrics/logs",
  },
] as const;

function roleBadgeClasses(roleId: string) {
  if (roleId === "game-server-admin")
    return "border-red-500/30 bg-red-500/10 text-red-300";
  if (roleId === "game-server-operator")
    return "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]";
  if (roleId === "game-server-viewer")
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  return "border-[#333] bg-[#1a1a1a] text-[#888]";
}

function sourceBadgeClasses(source: InheritedAccessAssignment["source"]) {
  return source === "platform"
    ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
    : "border-violet-500/30 bg-violet-500/10 text-violet-300";
}

function sourceLabel(source: InheritedAccessAssignment["source"]) {
  return source === "platform" ? "Platform Inherited" : "Game Hub Inherited";
}

function ServerRbacPanel({
  serverName,
  canEdit,
}: {
  serverName: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const scope = `/game-hub/servers/${serverName}`;
  const [showInherited, setShowInherited] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addUsername, setAddUsername] = useState("");
  const [addRole, setAddRole] = useState<ServerAccessRole>(
    GAME_SERVER_ROLES[0].id,
  );
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const accessQuery = useQuery<ServerAccessResponse>({
    queryKey: ["game-hub", "server-access", serverName],
    queryFn: () =>
      fetchJson<ServerAccessResponse>(
        `/api/game-hub/servers/${serverName}/access`,
      ),
    staleTime: 30000,
  });

  const availableUsers = accessQuery.data?.availableUsers ?? [];
  const inheritedAssignments = accessQuery.data?.inherited ?? [];
  const serverAssignments = accessQuery.data?.serverAssignments ?? [];

  useEffect(() => {
    if (!addUsername && availableUsers.length > 0) {
      setAddUsername(availableUsers[0]);
    }
  }, [addUsername, availableUsers]);

  async function refreshAccess() {
    await queryClient.invalidateQueries({
      queryKey: ["game-hub", "server-access", serverName],
    });
    await queryClient.invalidateQueries({
      queryKey: ["game-hub", "server", serverName],
    });
  }

  async function addAssignment() {
    if (!canEdit) return;
    if (!addUsername) {
      toast.error("Select a user first");
      return;
    }

    setAdding(true);
    try {
      await fetchJson(`/api/game-hub/servers/${serverName}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: addUsername, role: addRole }),
      });
      toast.success(`${addRole} granted to ${addUsername}`);
      setShowAdd(false);
      await refreshAccess();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setAdding(false);
    }
  }

  async function removeAssignment(assignment: ServerAccessAssignment) {
    if (!canEdit) return;

    setRemoving(`${assignment.user}:${assignment.role}`);
    try {
      const params = new URLSearchParams({
        username: assignment.user,
        role: assignment.role,
      });
      await fetchJson(
        `/api/game-hub/servers/${serverName}/access?${params.toString()}`,
        {
          method: "DELETE",
        },
      );
      toast.success(`Removed ${assignment.role} from ${assignment.user}`);
      await refreshAccess();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-[#1e1e1e]">
        <div className="flex items-start gap-2">
          <Shield className="w-3.5 h-3.5 text-[#555] mt-0.5" />
          <div>
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
              Access Control
            </p>
            <p className="text-[11px] text-[#555] mt-1">
              Inherited access is read-only here. Server-specific assignments
              are stored in users.yaml.
            </p>
          </div>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-[#2a2a2a] text-[#555] font-mono">
          {scope}
        </span>
      </div>

      <div className="p-4 space-y-4">
        {!canEdit && (
          <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-xs text-[#777]">
            Read-only. Only Game Hub admins can change server assignments.
          </div>
        )}

        {accessQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-[#555]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading access assignments…
          </div>
        ) : accessQuery.error ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            Failed to load access control details.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] overflow-hidden">
              <button
                type="button"
                onClick={() => setShowInherited((prev) => !prev)}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
              >
                <div>
                  <p className="text-sm text-[#f2f2f2]">Inherited access</p>
                  <p className="text-xs text-[#555] mt-1">
                    Platform-wide and Game Hub-wide roles that also apply to
                    this server.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-[#666]">
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#2a2a2a]">
                    {inheritedAssignments.length}
                  </span>
                  <ChevronRight
                    className={cn(
                      "w-4 h-4 transition-transform",
                      showInherited && "rotate-90",
                    )}
                  />
                </div>
              </button>
              <AnimatePresence initial={false}>
                {showInherited && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="border-t border-[#1e1e1e] p-3 space-y-2"
                  >
                    {inheritedAssignments.length === 0 ? (
                      <p className="text-xs text-[#555]">
                        No inherited assignments found for this server.
                      </p>
                    ) : (
                      inheritedAssignments.map((assignment) => (
                        <div
                          key={`${assignment.user}:${assignment.role}:${assignment.scope}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm text-[#f2f2f2] truncate">
                                {assignment.user}
                              </p>
                              <span
                                className={cn(
                                  "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                                  sourceBadgeClasses(assignment.source),
                                )}
                              >
                                {sourceLabel(assignment.source)}
                              </span>
                            </div>
                            <p className="text-[10px] text-[#555] font-mono mt-1">
                              {assignment.scope}
                            </p>
                          </div>
                          <span
                            className={cn(
                              "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                              roleBadgeClasses(assignment.role),
                            )}
                          >
                            {assignment.role}
                          </span>
                        </div>
                      ))
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-3 py-3 border-b border-[#1e1e1e]">
                <div>
                  <p className="text-sm text-[#f2f2f2]">
                    Server-specific access
                  </p>
                  <p className="text-xs text-[#555] mt-1">
                    Users assigned directly to this server only.
                  </p>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        !showAdd &&
                        !addUsername &&
                        availableUsers.length > 0
                      ) {
                        setAddUsername(availableUsers[0]);
                      }
                      setShowAdd((prev) => !prev);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0078D4]/15 hover:bg-[#0078D4]/25 text-[#4db3ff] text-xs font-medium transition-colors"
                  >
                    <Plus className="w-3 h-3" /> Add User
                  </button>
                )}
              </div>
              <div className="p-3 space-y-3">
                <AnimatePresence initial={false}>
                  {showAdd && canEdit && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="rounded-lg border border-[#0078D4]/30 bg-[#0d1e33] p-4 space-y-3"
                    >
                      <p className="text-xs font-medium text-[#4db3ff]">
                        Grant direct server access
                      </p>
                      <div className="grid lg:grid-cols-[1fr_220px_auto] gap-2">
                        <div>
                          <label className="block text-[10px] text-[#666] mb-1">
                            Username
                          </label>
                          <select
                            value={addUsername}
                            onChange={(event) =>
                              setAddUsername(event.target.value)
                            }
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                          >
                            {availableUsers.length === 0 ? (
                              <option value="">No users available</option>
                            ) : (
                              availableUsers.map((username) => (
                                <option key={username} value={username}>
                                  {username}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] text-[#666] mb-1">
                            Role
                          </label>
                          <select
                            value={addRole}
                            onChange={(event) =>
                              setAddRole(event.target.value as ServerAccessRole)
                            }
                            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                          >
                            {GAME_SERVER_ROLES.map((role) => (
                              <option key={role.id} value={role.id}>
                                {role.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <button
                          type="button"
                          onClick={addAssignment}
                          disabled={
                            adding ||
                            !addUsername ||
                            availableUsers.length === 0
                          }
                          className="h-fit self-end px-3 py-2 rounded-lg bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white text-xs font-medium flex items-center justify-center gap-1.5"
                        >
                          {adding ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Plus className="w-3 h-3" />
                          )}
                          Add
                        </button>
                      </div>
                      <div className="grid gap-2 md:grid-cols-3">
                        {GAME_SERVER_ROLES.map((role) => (
                          <div
                            key={role.id}
                            className="rounded-lg border border-[#234] bg-[#08111d] px-3 py-2"
                          >
                            <p className="text-[11px] text-[#f2f2f2] font-mono">
                              {role.label}
                            </p>
                            <p className="text-[10px] text-[#6f88a6] mt-1">
                              {role.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {serverAssignments.length === 0 ? (
                  <p className="text-xs text-[#555]">
                    No server-specific assignments yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {serverAssignments.map((assignment) => {
                      const assignmentKey = `${assignment.user}:${assignment.role}`;
                      return (
                        <div
                          key={assignmentKey}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-[#f2f2f2] truncate">
                              {assignment.user}
                            </p>
                            <p className="text-[10px] text-[#555] font-mono mt-1">
                              {scope}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "text-[10px] px-2 py-0.5 rounded-full border font-medium",
                                roleBadgeClasses(assignment.role),
                              )}
                            >
                              {assignment.role}
                            </span>
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() => removeAssignment(assignment)}
                                disabled={removing === assignmentKey}
                                title={`Remove ${assignment.user}'s access`}
                                className="p-1.5 rounded-lg text-[#555] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                              >
                                {removing === assignmentKey ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SettingsTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const envImportRef = useRef<HTMLInputElement>(null);
  const defaultEgg = getEggForGameType(server.gameType);
  const defaultEnv = Object.fromEntries(
    (defaultEgg.environment ?? []).map((entry) => [
      entry.name,
      entry.defaultValue,
    ]),
  );
  const currentEnv = Object.fromEntries(
    server.env.map((entry) => [entry.name, entry.value ?? ""]),
  );
  const envDiff = [
    ...new Set([...Object.keys(defaultEnv), ...Object.keys(currentEnv)]),
  ]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const defaultValue = defaultEnv[key];
      const currentValue = currentEnv[key];
      const state =
        defaultValue === undefined
          ? "added"
          : currentValue === undefined
            ? "removed"
            : currentValue !== defaultValue
              ? "changed"
              : "same";
      return { key, defaultValue, currentValue, state };
    })
    .filter((entry) => entry.state !== "same");
  const isLonghornPvc = Boolean(
    server.pvc?.storageClass?.toLowerCase().includes("longhorn"),
  );
  const initialScheduleDays =
    server.scheduleStart?.days?.length
      ? server.scheduleStart.days
      : server.scheduleStop?.days?.length
        ? server.scheduleStop.days
        : ALL_SCHEDULE_DAYS;

  const [replicaMode, setReplicaMode] = useState<"static" | "dynamic">(
    server.hpa.enabled ? "dynamic" : "static",
  );
  const [staticCount, setStaticCount] = useState(
    Math.max(server.replicas ?? 1, 1),
  );
  const [hpaMin, setHpaMin] = useState(server.hpa.min);
  const [hpaMax, setHpaMax] = useState(server.hpa.max);
  const [hpaCpu, setHpaCpu] = useState(server.hpa.cpuTarget ?? 70);
  const [scaleSaving, setScaleSaving] = useState(false);
  const [autoRestart, setAutoRestart] = useState(
    server.restartPolicy !== "OnFailure",
  );
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
  const [icon, setIcon] = useState(server.icon ?? "��");
  const [tags, setTags] = useState<string[]>(server.tags ?? []);
  const [tagInput, setTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const [groupsStr, setGroupsStr] = useState((server.groups ?? []).join(", "));
  const [image, setImage] = useState(server.image ?? "");
  const [imagePullPolicy, setImagePullPolicy] = useState(
    server.imagePullPolicy ?? "IfNotPresent",
  );
  const [deploymentStrategy, setDeploymentStrategy] = useState(
    server.deploymentStrategy ?? "RollingUpdate",
  );
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlContent, setYamlContent] = useState(server.deploymentYaml ?? "");
  const [yamlLoading, setYamlLoading] = useState(false);
  const [servicePorts, setServicePorts] = useState<EditablePort[]>(
    (server.allPorts ?? []).map((port, index) => ({
      id: `${port.name ?? "port"}-${index}`,
      name: port.name ?? "",
      port: port.port,
      targetPort: Number(port.targetPort ?? port.port),
      protocol: port.protocol,
    })),
  );
  const [scheduledAction, setScheduledAction] = useState(
    server.scheduledAction ?? "none",
  );
  const [scheduledTime, setScheduledTime] = useState(
    formatScheduledValue(server.scheduledTime),
  );
  const [scheduleStartEnabled, setScheduleStartEnabled] = useState(
    Boolean(server.scheduleStart),
  );
  const [scheduleStartTime, setScheduleStartTime] = useState(
    server.scheduleStart?.time ?? "08:00",
  );
  const [scheduleStopEnabled, setScheduleStopEnabled] = useState(
    Boolean(server.scheduleStop),
  );
  const [scheduleStopTime, setScheduleStopTime] = useState(
    server.scheduleStop?.time ?? "22:00",
  );
  const [scheduleDays, setScheduleDays] = useState<string[]>(initialScheduleDays);
  const [scheduleTimezone, setScheduleTimezone] = useState(
    server.scheduleStart?.timezone ??
      server.scheduleStop?.timezone ??
      getDefaultScheduleTimezone(),
  );
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [alertCpu, setAlertCpu] = useState(server.alertCpu ?? 80);
  const [alertMemory, setAlertMemory] = useState(server.alertMemory ?? 80);
  const [alertRestarts, setAlertRestarts] = useState(
    server.alertRestarts ?? 5,
  );
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [commandLabel, setCommandLabel] = useState("");
  const [commandText, setCommandText] = useState("");
  const isServerStopped = server.replicas === 0 || server.status === "stopped";

  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const {
    data: snapshotsData,
    refetch: refetchSnapshots,
    isFetching: snapshotsLoading,
  } = useQuery({
    queryKey: ["game-hub", "snapshots", name],
    queryFn: () =>
      fetchJson<{
        snapshots: Array<{
          metadata?: {
            name?: string;
            creationTimestamp?: string;
            annotations?: Record<string, string>;
          };
          status?: { readyToUse?: boolean };
        }>;
      }>(`/api/game-hub/servers/${name}/snapshot`),
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
        await patchServer(
          { action: "scale", replicas: staticCount },
          `Set to ${staticCount} replica${staticCount !== 1 ? "s" : ""}`,
        );
      } else {
        await patchServer(
          { action: "set-hpa", hpaMin, hpaMax, hpaCpuTarget: hpaCpu },
          `Auto-scale enabled: ${hpaMin}–${hpaMax} replicas @ ${hpaCpu}% CPU`,
        );
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
      await patchServer(
        { action: "set-restart-policy", restartPolicy: next },
        next
          ? "Crash restart enabled"
          : "Crash restart limited to failures only",
      );
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
      await patchServer(
        {
          action: "update-resources",
          memory: memLimit.trim(),
          cpu: cpuLimit.trim(),
        },
        "Resource limits updated",
      );
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingResources(false);
    }
  }

  function toggleScheduleDay(day: string) {
    setScheduleDays((current) =>
      current.includes(day)
        ? current.filter((entry) => entry !== day)
        : [...current, day],
    );
  }

  async function saveSchedule() {
    if ((scheduleStartEnabled || scheduleStopEnabled) && scheduleDays.length === 0) {
      toast.error("Select at least one day");
      return;
    }
    setSavingSchedule(true);
    try {
      await patchServer(
        {
          action: "set-schedule",
          startSchedule: buildSchedulePayload(
            scheduleStartEnabled,
            scheduleStartTime,
            scheduleDays,
            scheduleTimezone,
          ),
          stopSchedule: buildSchedulePayload(
            scheduleStopEnabled,
            scheduleStopTime,
            scheduleDays,
            scheduleTimezone,
          ),
        },
        "Power schedule saved",
      );
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingSchedule(false);
    }
  }

  async function saveAlertThresholds() {
    setSavingThresholds(true);
    try {
      await patchServer(
        {
          action: "set-alert-thresholds",
          alertCpu,
          alertMemory,
          alertRestarts,
        },
        "Alert thresholds saved",
      );
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingThresholds(false);
    }
  }

  async function testWebhook() {
    setTestingWebhook(true);
    try {
      await fetchJson(`/api/game-hub/servers/${name}/webhooks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      toast.success("Test webhook sent");
    } catch (error) {
      toast.error(String(error));
    } finally {
      setTestingWebhook(false);
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
      await patchServer(
        { action: "update-env", env },
        "Saved — restart the server to apply changes",
      );
      setEditingEnv(false);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingEnv(false);
    }
  }

  function exportEnv() {
    downloadTextFile(
      `${name}.env`,
      editingEnv ? envStr : stringifyEnv(server.env),
    );
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
      await patchServer(
        {
          action: "update-identity",
          description,
          icon,
          groups: groupsStr
            .split(",")
            .map((group) => group.trim())
            .filter(Boolean),
        },
        "Server identity updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveTags(nextTags: string[]) {
    setSavingTags(true);
    try {
      await patchServer(
        { action: "update-identity", tags: nextTags },
        nextTags.length > 0 ? "Tags updated" : "Tags cleared",
      );
      setTags(nextTags);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingTags(false);
    }
  }

  function addTag() {
    const nextTag = tagInput.trim();
    if (!nextTag) return;
    const nextTags = [...new Set([...tags, nextTag])];
    setTagInput("");
    if (nextTags.length !== tags.length) void saveTags(nextTags);
  }

  function removeTag(tag: string) {
    void saveTags(tags.filter((entry) => entry !== tag));
  }

  async function saveImage() {
    try {
      await patchServer(
        { action: "update-image", image },
        "Container image updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function savePullPolicy() {
    try {
      await patchServer(
        { action: "update-pull-policy", pullPolicy: imagePullPolicy },
        "Pull policy updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveStrategy() {
    try {
      await patchServer(
        { action: "update-strategy", strategy: deploymentStrategy },
        "Deployment strategy updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function rollbackDeployment() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/rollback`, {
        method: "POST",
      });
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
      const result = await fetchJson<ServerDetail>(
        `/api/game-hub/servers/${name}?includeYaml=1`,
      );
      setYamlContent(result.deploymentYaml ?? "# YAML unavailable");
    } catch (error) {
      toast.error(String(error));
      setYamlContent("# Failed to load deployment YAML");
    } finally {
      setYamlLoading(false);
    }
  }

  function updatePort(id: string, patch: Partial<EditablePort>) {
    setServicePorts((ports) =>
      ports.map((port) => (port.id === id ? { ...port, ...patch } : port)),
    );
  }

  function addPortRow() {
    setServicePorts((ports) => [
      ...ports,
      {
        id: `${Date.now()}-${ports.length}`,
        name: "",
        port: 25565,
        targetPort: 25565,
        protocol: "TCP",
      },
    ]);
  }

  function removePortRow(id: string) {
    setServicePorts((ports) => ports.filter((port) => port.id !== id));
  }

  async function savePorts() {
    try {
      const ports = servicePorts
        .filter((port) => port.port > 0)
        .map((port) => ({
          name: port.name || undefined,
          port: Number(port.port),
          targetPort: Number(port.targetPort || port.port),
          protocol: port.protocol as "TCP" | "UDP",
        }));
      await patchServer(
        { action: "update-service-ports", ports },
        "Service ports updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function saveScheduledAction() {
    try {
      await patchServer(
        {
          action: "set-scheduled-action",
          scheduledAction: scheduledAction === "none" ? null : scheduledAction,
          scheduledTime: scheduledTime || null,
        },
        "Scheduled action updated",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function createSnapshot() {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
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
      await patchServer(
        { action: "save-command", command: { label, cmd } },
        "Saved command added",
      );
      setCommandLabel("");
      setCommandText("");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function deleteQuickCommand(entry: RuntimeSavedCommand) {
    try {
      await patchServer(
        { action: "delete-saved-command", commandId: entry.id },
        "Saved command removed",
      );
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function exportServer() {
    try {
      const result = await fetchJson<ServerDetail>(
        `/api/game-hub/servers/${name}`,
      );
      downloadTextFile(
        `${name}-config.json`,
        JSON.stringify(
          {
            name: result.name,
            gameType: result.gameType,
            dockerImage: result.image,
            env: Object.fromEntries(
              result.env.map((entry) => [entry.name, entry.value ?? ""]),
            ),
            ports: result.allPorts,
            resources: { cpu: result.cpu, memory: result.memory },
            replicas: result.replicas,
            pvcSize: result.pvc?.size ?? null,
            egg: result.egg,
          },
          null,
          2,
        ),
        "application/json",
      );
      toast.success("Server export downloaded");
    } catch (error) {
      toast.error(String(error));
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Layers className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Replica Scaling
          </p>
          {server.hpa.enabled && (
            <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-400 border border-blue-500/20">
              HPA active
            </span>
          )}
        </div>
        <div className="p-4 space-y-4">
          {isServerStopped && (
            <p className="text-xs text-[#888] rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2">
              Server is stopped. Use Start/Stop to control server state.
            </p>
          )}
          <div className="flex gap-2">
            {(["static", "dynamic"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setReplicaMode(mode)}
                className={cn(
                  "flex-1 py-2 rounded-lg text-xs font-medium transition-colors border",
                  replicaMode === mode
                    ? "bg-[#0078D4]/20 border-[#0078D4]/50 text-[#0078D4]"
                    : "bg-transparent border-[#2a2a2a] text-[#666] hover:text-[#888]",
                )}
              >
                {mode === "static" ? "Static (fixed)" : "Dynamic (HPA)"}
              </button>
            ))}
          </div>
          {replicaMode === "static" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <label className="text-xs text-[#666] flex-shrink-0">
                  Replicas
                </label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      setStaticCount((count) => Math.max(1, count - 1))
                    }
                    disabled={isServerStopped}
                    className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-40 text-[#888] text-sm font-bold flex items-center justify-center"
                  >
                    −
                  </button>
                  <span className="min-w-[92px] text-center text-sm font-mono text-[#f2f2f2]">
                    {isServerStopped ? "0 (stopped)" : staticCount}
                  </span>
                  <button
                    onClick={() =>
                      setStaticCount((count) => Math.min(10, count + 1))
                    }
                    disabled={isServerStopped}
                    className="w-7 h-7 rounded bg-[#1e1e1e] hover:bg-[#2a2a2a] disabled:opacity-40 text-[#888] text-sm font-bold flex items-center justify-center"
                  >
                    +
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-[#555]">
                Use Start/Stop to control server state. Static replicas cannot
                go below 1 while running.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">
                    Min replicas
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={hpaMin}
                    onChange={(event) =>
                      setHpaMin(
                        Math.max(1, parseInt(event.target.value, 10) || 1),
                      )
                    }
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">
                    Max replicas
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={hpaMax}
                    onChange={(event) =>
                      setHpaMax(
                        Math.max(hpaMin, parseInt(event.target.value, 10) || 1),
                      )
                    }
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] mb-1">
                    CPU target %
                  </label>
                  <input
                    type="number"
                    min={10}
                    max={100}
                    value={hpaCpu}
                    onChange={(event) =>
                      setHpaCpu(
                        Math.min(
                          100,
                          Math.max(10, parseInt(event.target.value, 10) || 70),
                        ),
                      )
                    }
                    className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
              </div>
              {server.hpa.currentReplicas !== null && (
                <p className="text-[10px] text-[#555]">
                  Currently running {server.hpa.currentReplicas} replica(s) via
                  HPA
                </p>
              )}
            </div>
          )}
          <button
            onClick={saveReplicas}
            disabled={
              scaleSaving || (replicaMode === "static" && isServerStopped)
            }
            className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {scaleSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}{" "}
            Apply scaling
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <RotateCcw className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Auto-restart Policy
          </p>
        </div>
        <div className="p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#f2f2f2]">Restart on crash</p>
            <p className="text-xs text-[#555] mt-0.5">
              Automatically restart if the server process exits unexpectedly
            </p>
          </div>
          <button
            onClick={toggleAutoRestart}
            disabled={savingRestart}
            className={cn(
              "relative w-11 h-6 rounded-full transition-colors flex-shrink-0",
              autoRestart ? "bg-[#0078D4]" : "bg-[#2a2a2a]",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow",
                autoRestart ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Clock className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Scheduled On/Off
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-[#f2f2f2]">Enable scheduled start</p>
                  <p className="text-[11px] text-[#555]">Scale the server back to 1 replica on the selected days.</p>
                </div>
                <button
                  onClick={() => setScheduleStartEnabled((current) => !current)}
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors flex-shrink-0",
                    scheduleStartEnabled ? "bg-[#0078D4]" : "bg-[#2a2a2a]",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow",
                      scheduleStartEnabled ? "translate-x-5" : "translate-x-0",
                    )}
                  />
                </button>
              </div>
              <input
                type="time"
                step={60}
                value={scheduleStartTime}
                onChange={(event) => setScheduleStartTime(event.target.value)}
                disabled={!scheduleStartEnabled}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] disabled:opacity-50 focus:outline-none focus:border-[#0078D4]"
              />
            </div>
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-[#f2f2f2]">Enable scheduled stop</p>
                  <p className="text-[11px] text-[#555]">Scale the server down cleanly at the chosen time.</p>
                </div>
                <button
                  onClick={() => setScheduleStopEnabled((current) => !current)}
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors flex-shrink-0",
                    scheduleStopEnabled ? "bg-[#0078D4]" : "bg-[#2a2a2a]",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform shadow",
                      scheduleStopEnabled ? "translate-x-5" : "translate-x-0",
                    )}
                  />
                </button>
              </div>
              <input
                type="time"
                step={60}
                value={scheduleStopTime}
                onChange={(event) => setScheduleStopTime(event.target.value)}
                disabled={!scheduleStopEnabled}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] disabled:opacity-50 focus:outline-none focus:border-[#0078D4]"
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_220px]">
            <div>
              <label className="block text-[10px] text-[#666] mb-2">Days of week</label>
              <div className="flex flex-wrap gap-2">
                {SCHEDULE_DAY_OPTIONS.map((day) => {
                  const active = scheduleDays.includes(day.value);
                  return (
                    <button
                      key={day.value}
                      onClick={() => toggleScheduleDay(day.value)}
                      className={cn(
                        "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                        active
                          ? "border-[#0078D4]/50 bg-[#0078D4]/15 text-[#7cc2ff]"
                          : "border-[#2a2a2a] bg-[#0a0a0a] text-[#777] hover:text-[#bbb]",
                      )}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-2">Timezone</label>
              <input
                value={scheduleTimezone}
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="America/New_York"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] font-mono focus:outline-none focus:border-[#0078D4]"
              />
              <p className="mt-1 text-[10px] text-[#555]">CronJobs use this IANA timezone.</p>
            </div>
          </div>
          <button
            onClick={saveSchedule}
            disabled={savingSchedule}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {savingSchedule ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Save Schedule
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <AlertTriangle className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Alert Thresholds
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="block text-[10px] text-[#666] mb-1">CPU warning at</label>
              <div className="flex items-center rounded border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={alertCpu}
                  onChange={(event) =>
                    setAlertCpu(
                      Math.min(100, Math.max(0, parseInt(event.target.value, 10) || 0)),
                    )
                  }
                  className="w-full bg-transparent text-sm text-[#f2f2f2] focus:outline-none"
                />
                <span className="text-xs text-[#666]">%</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1">Memory warning at</label>
              <div className="flex items-center rounded border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={alertMemory}
                  onChange={(event) =>
                    setAlertMemory(
                      Math.min(100, Math.max(0, parseInt(event.target.value, 10) || 0)),
                    )
                  }
                  className="w-full bg-transparent text-sm text-[#f2f2f2] focus:outline-none"
                />
                <span className="text-xs text-[#666]">%</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1">Max restart count</label>
              <input
                type="number"
                min={1}
                max={20}
                value={alertRestarts}
                onChange={(event) =>
                  setAlertRestarts(
                    Math.min(20, Math.max(1, parseInt(event.target.value, 10) || 1)),
                  )
                }
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={saveAlertThresholds}
              disabled={savingThresholds}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
            >
              {savingThresholds ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save Thresholds
            </button>
            <button
              onClick={testWebhook}
              disabled={testingWebhook}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-yellow-200 text-sm font-medium hover:bg-yellow-500/15 disabled:opacity-50"
            >
              {testingWebhook ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Test webhook
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
              Server Notes
            </p>
          </div>
          <button
            onClick={saveNotes}
            disabled={savingNotes}
            className="text-xs text-[#0078D4] hover:underline"
          >
            {savingNotes ? "Saving..." : "Save"}
          </button>
        </div>
        <div className="p-4">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={4}
            placeholder="Add notes about this server, connection info, admin contacts..."
            className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] placeholder:text-[#333]"
          />
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Cpu className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Resource Limits
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-[#666] mb-1">
                Memory limit
              </label>
              <input
                value={memLimit}
                onChange={(event) => setMemLimit(event.target.value)}
                placeholder="e.g. 2Gi, 512Mi"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1">
                CPU limit
              </label>
              <input
                value={cpuLimit}
                onChange={(event) => setCpuLimit(event.target.value)}
                placeholder="e.g. 1, 500m"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
            </div>
          </div>
          <button
            onClick={saveResources}
            disabled={savingResources}
            className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {savingResources ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}{" "}
            Apply limits
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
          <div className="flex items-center gap-2">
            <Shield className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
              Environment Variables
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={exportEnv}
              className="text-xs text-[#9e9e9e] hover:text-white"
            >
              Export .env
            </button>
            <button
              onClick={() => envImportRef.current?.click()}
              className="text-xs text-[#9e9e9e] hover:text-white"
            >
              Import .env
            </button>
            <button
              onClick={() => setEditingEnv((prev) => !prev)}
              className="text-xs text-[#0078D4] hover:underline"
            >
              {editingEnv ? "Cancel" : "Edit"}
            </button>
          </div>
        </div>
        <input
          ref={envImportRef}
          type="file"
          accept=".env,text/plain"
          className="hidden"
          onChange={importEnvFile}
        />
        <div className="p-4 space-y-4">
          {editingEnv ? (
            <div className="space-y-3">
              <p className="text-xs text-[#555]">
                One <code className="text-[#888]">KEY=VALUE</code> per line.
                Sensitive values are hidden in display mode.
              </p>
              <textarea
                value={envStr}
                onChange={(event) => setEnvStr(event.target.value)}
                rows={12}
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm font-mono text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4] leading-relaxed"
              />
              <button
                onClick={saveEnv}
                disabled={savingEnv}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#0078D4] text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {savingEnv ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}{" "}
                Save changes
              </button>
            </div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {server.env.length === 0 ? (
                <p className="text-xs text-[#555]">
                  No environment variables set.
                </p>
              ) : (
                server.env.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-start gap-2 text-xs py-0.5"
                  >
                    <span className="font-mono text-[#0078D4] flex-shrink-0 w-24 sm:min-w-[120px] break-all">
                      {entry.name}
                    </span>
                    <span className="text-[#444]">=</span>
                    <span
                      className={cn(
                        "font-mono break-all",
                        entry.name.match(/PASS|SECRET|KEY|TOKEN/i)
                          ? "text-[#444] italic"
                          : "text-[#9e9e9e]",
                      )}
                    >
                      {entry.name.match(/PASS|SECRET|KEY|TOKEN/i)
                        ? "••••••••"
                        : (entry.value ?? "<from secret>")}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
          <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3">
            <p className="text-[11px] uppercase tracking-wide text-[#666] mb-2">
              Config Diff vs Egg Defaults
            </p>
            {envDiff.length === 0 ? (
              <p className="text-xs text-[#555]">
                No differences from the egg defaults.
              </p>
            ) : (
              <div className="space-y-2">
                {envDiff.map((entry) => (
                  <div
                    key={entry.key}
                    className={cn(
                      "rounded border px-3 py-2 text-xs",
                      entry.state === "added"
                        ? "border-green-500/20 bg-green-500/5"
                        : entry.state === "removed"
                          ? "border-red-500/20 bg-red-500/5"
                          : "border-yellow-500/20 bg-yellow-500/5",
                    )}
                  >
                    <div className="font-mono text-[#f2f2f2]">{entry.key}</div>
                    <div className="mt-1 text-[#777]">
                      Default:{" "}
                      <span className="font-mono">
                        {entry.defaultValue ?? "<unset>"}
                      </span>
                    </div>
                    <div className="text-[#777]">
                      Current:{" "}
                      <span className="font-mono">
                        {entry.currentValue ?? "<unset>"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <FileText className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Description & Identity
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[10px] text-[#666] mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 text-sm text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4]"
            />
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-2">Icon</label>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
              {ICON_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => setIcon(emoji)}
                  className={cn(
                    "h-10 rounded-lg border text-lg transition-colors",
                    icon === emoji
                      ? "border-[#0078D4] bg-[#0078D4]/15"
                      : "border-[#2a2a2a] bg-[#0a0a0a] hover:border-[#3a3a3a]",
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1">Tags</label>
            <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 space-y-3">
              <div className="flex flex-wrap gap-2">
                {tags.length === 0 ? (
                  <span className="text-xs text-[#555]">No tags yet.</span>
                ) : (
                  tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full border border-[#0078D4]/30 bg-[#0078D4]/10 px-2.5 py-1 text-xs text-[#7cc2ff]"
                    >
                      {tag}
                      <button
                        onClick={() => removeTag(tag)}
                        disabled={savingTags}
                        className="text-[#9dd4ff] hover:text-white disabled:opacity-40"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="Add a tag"
                  className="flex-1 bg-[#111] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                />
                <button
                  onClick={addTag}
                  disabled={!tagInput.trim() || savingTags}
                  className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] disabled:opacity-40"
                >
                  {savingTags ? "Saving..." : "Add tag"}
                </button>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-[#666] mb-1">Groups</label>
            <input
              value={groupsStr}
              onChange={(event) => setGroupsStr(event.target.value)}
              placeholder="production, testing, friends"
              className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
          </div>
          <button
            onClick={saveIdentity}
            className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
          >
            Save identity
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Package className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Image & Deployment
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[10px] text-[#666] mb-1">Image</label>
            <div className="flex gap-2">
              <input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
              <button
                onClick={saveImage}
                className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
              >
                Save image
              </button>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] text-[#666] mb-1">
                Image pull policy
              </label>
              <div className="flex gap-2">
                <select
                  value={imagePullPolicy}
                  onChange={(event) => setImagePullPolicy(event.target.value)}
                  className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="Always">Always</option>
                  <option value="IfNotPresent">IfNotPresent</option>
                  <option value="Never">Never</option>
                </select>
                <button
                  onClick={savePullPolicy}
                  className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]"
                >
                  Save
                </button>
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-[#666] mb-1">
                Deployment strategy
              </label>
              <div className="flex gap-2">
                <select
                  value={deploymentStrategy}
                  onChange={(event) =>
                    setDeploymentStrategy(event.target.value)
                  }
                  className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="RollingUpdate">RollingUpdate</option>
                  <option value="Recreate">Recreate</option>
                </select>
                <button
                  onClick={saveStrategy}
                  className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={rollbackDeployment}
              className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] hover:bg-[#222]"
            >
              Rollback
            </button>
            <button
              onClick={viewYaml}
              className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] hover:bg-[#222]"
            >
              View Raw YAML
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Wifi className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Service Ports
          </p>
        </div>
        <div className="p-4 space-y-3">
          <div className="space-y-2">
            {servicePorts.map((port) => (
              <div
                key={port.id}
                className="grid grid-cols-[1fr_110px_110px_110px_auto] gap-2 items-center"
              >
                <input
                  value={port.name}
                  onChange={(event) =>
                    updatePort(port.id, { name: event.target.value })
                  }
                  placeholder="name"
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                />
                <input
                  type="number"
                  min={1}
                  value={port.port}
                  onChange={(event) =>
                    updatePort(port.id, {
                      port: Math.max(1, parseInt(event.target.value, 10) || 1),
                    })
                  }
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                />
                <input
                  type="number"
                  min={1}
                  value={port.targetPort}
                  onChange={(event) =>
                    updatePort(port.id, {
                      targetPort: Math.max(
                        1,
                        parseInt(event.target.value, 10) || 1,
                      ),
                    })
                  }
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                />
                <select
                  value={port.protocol}
                  onChange={(event) =>
                    updatePort(port.id, { protocol: event.target.value })
                  }
                  className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                </select>
                <button
                  onClick={() => removePortRow(port.id)}
                  disabled={servicePorts.length <= 1}
                  className="p-2 rounded-lg border border-[#2a2a2a] text-[#777] hover:text-red-300 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={addPortRow}
              className="px-3 py-2 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4] flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              Add port
            </button>
            <button
              onClick={savePorts}
              className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Clock className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Scheduled Action
          </p>
        </div>
        <div className="p-4 space-y-3">
          {server.scheduledAction && server.scheduledTime && (
            <p className="text-xs text-[#888]">
              Current schedule:{" "}
              <span className="text-[#f2f2f2]">{server.scheduledAction}</span> @{" "}
              {formatDateTime(server.scheduledTime)}
            </p>
          )}
          <p className="text-[11px] text-[#666]">
            Scheduled actions require the platform to be running so the
            controller can apply them.
          </p>
          <div className="grid md:grid-cols-[200px_1fr_auto] gap-2">
            <select
              value={scheduledAction}
              onChange={(event) => setScheduledAction(event.target.value)}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            >
              <option value="none">None</option>
              <option value="stop">Stop</option>
              <option value="restart">Restart</option>
            </select>
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(event) => setScheduledTime(event.target.value)}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
            <button
              onClick={saveScheduledAction}
              className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <HardDrive className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            PVC Snapshots
          </p>
        </div>
        <div className="p-4 space-y-3">
          {!isLonghornPvc ? (
            <p className="text-xs text-[#666]">
              Snapshots are available for Longhorn-backed PVCs.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[#888]">
                  Create CSI snapshots for {server.pvc?.name ?? "this PVC"}.
                </p>
                <button
                  onClick={createSnapshot}
                  className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
                >
                  Create Snapshot
                </button>
              </div>
              <div className="space-y-2">
                {(snapshotsData?.snapshots ?? []).length === 0 ? (
                  <p className="text-xs text-[#555]">
                    {snapshotsLoading
                      ? "Loading snapshots..."
                      : "No snapshots found."}
                  </p>
                ) : (
                  (snapshotsData?.snapshots ?? []).map((snapshot) => (
                    <div
                      key={snapshot.metadata?.name}
                      className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[#f2f2f2]">
                          {snapshot.metadata?.name}
                        </span>
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded-full border text-[10px]",
                            snapshot.status?.readyToUse
                              ? "border-green-500/30 bg-green-500/10 text-green-300"
                              : "border-yellow-500/30 bg-yellow-500/10 text-yellow-300",
                          )}
                        >
                          {snapshot.status?.readyToUse ? "Ready" : "Pending"}
                        </span>
                      </div>
                      <p className="text-[#666] mt-1">
                        {snapshot.metadata?.creationTimestamp
                          ? formatDateTime(snapshot.metadata.creationTimestamp)
                          : "Waiting for controller"}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Terminal className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Saved Quick Commands
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            {savedCommands.length === 0 ? (
              <p className="text-xs text-[#555]">No saved commands yet.</p>
            ) : (
              savedCommands.map((entry) => (
                <div
                  key={`${entry.id ?? entry.label}-${entry.command}`}
                  className="flex items-center gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[#f2f2f2]">{entry.label}</p>
                    <p className="text-xs text-[#777] font-mono truncate">
                      {entry.command}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteQuickCommand(entry)}
                    className="text-xs text-red-300 hover:text-red-200"
                  >
                    Delete
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="grid md:grid-cols-[180px_1fr_auto] gap-2">
            <input
              value={commandLabel}
              onChange={(event) => setCommandLabel(event.target.value)}
              placeholder="Label"
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
            <input
              value={commandText}
              onChange={(event) => setCommandText(event.target.value)}
              placeholder="Command"
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
            <button
              onClick={saveQuickCommand}
              className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
          <Download className="w-3.5 h-3.5 text-[#555]" />
          <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
            Server Export
          </p>
        </div>
        <div className="p-4">
          <button
            onClick={exportServer}
            className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
          >
            Export Config
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
        <div className="px-4 py-3 border-b border-red-500/20">
          <p className="text-xs font-medium text-red-400/80 uppercase tracking-wide">
            Danger Zone
          </p>
        </div>
        <div className="p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-[#f2f2f2]">Delete this server</p>
            <p className="text-xs text-[#666] mt-0.5">
              Permanently removes the deployment and all data. This cannot be
              undone.
            </p>
          </div>
          <button
            onClick={async () => {
              if (
                !confirm(
                  `Permanently delete ${name} and all its data? This cannot be undone.`,
                )
              )
                return;
              try {
                await fetchJson(`/api/game-hub/servers/${name}`, {
                  method: "DELETE",
                });
                toast.success(`${name} deleted`);
                window.location.href = "/game-hub";
              } catch (error) {
                toast.error(String(error));
              }
            }}
            className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      <ServerRbacPanel
        serverName={name}
        canEdit={Boolean(server.permissions?.canAdmin)}
      />

      <AnimatePresence>
        {yamlOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-5xl bg-[#111] border border-[#2a2a2a] rounded-xl overflow-hidden shadow-2xl"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e1e1e]">
                <div>
                  <p className="text-sm font-medium text-[#f2f2f2]">
                    Deployment YAML
                  </p>
                  <p className="text-xs text-[#666]">
                    Read-only deployment manifest
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(yamlContent);
                      toast.success("Copied");
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[#1a1a1a] border border-[#2a2a2a] text-xs text-[#d4d4d4]"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => setYamlOpen(false)}
                    className="p-2 text-[#777] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="h-[70vh]">
                {yamlLoading ? (
                  <div className="h-full flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-[#0078D4]" />
                  </div>
                ) : (
                  <pre className="h-full overflow-auto bg-[#1e1e1e] text-[#d4d4d4] font-mono text-[13px] leading-[1.5] p-3 m-0 whitespace-pre">
                    {yamlContent}
                  </pre>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function ServerDetailPage() {
  const { name } = useParams<{ name: string }>();
  const [activeTab, setActiveTab] = useState<TabId>("dashboard");
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const {
    data: server,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["game-hub", "server", name],
    queryFn: async () =>
      fetchJson<ServerDetail>(`/api/game-hub/servers/${name}`),
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

  const status = server?.maintenanceMode
    ? "maintenance"
    : server?.readyReplicas && server.readyReplicas > 0
      ? "running"
      : (server?.replicas ?? 0) > 0
        ? "starting"
        : "stopped";
  const mountPath = server?.egg?.mountPath ?? "/data";
  const statusDot = {
    running: "bg-green-400",
    starting: "bg-yellow-400 animate-pulse",
    maintenance: "bg-yellow-400",
    stopped: "bg-[#444]",
  }[status];
  const statusText = {
    running: "text-green-400",
    starting: "text-yellow-400",
    maintenance: "text-yellow-400",
    stopped: "text-[#666]",
  }[status];
  const connectionInfo =
    server?.nodeIp && server?.nodePort
      ? `${server.nodeIp}:${server.nodePort}`
      : server?.nodePort
        ? `Port ${server.nodePort}`
        : server?.port
          ? `Port ${server.port}`
          : "";

  useEffect(() => {
    if (typeof document === "undefined") return;
    const prefix =
      status === "running"
        ? "🟢"
        : status === "starting"
          ? "🟡"
          : status === "maintenance"
            ? "🟠"
            : "⚪";
    document.title = `${prefix} ${name} • InfraWeaver`;
    return () => {
      document.title = "InfraWeaver";
    };
  }, [name, status]);

  const tabs: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "console", label: "Console", icon: Terminal },
    ...(status !== "stopped"
      ? [{ id: "players" as const, label: "Players", icon: Users }]
      : []),
    { id: "files", label: "Files", icon: FolderOpen },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <div className="space-y-0 pb-2">
      <div className="sticky top-0 z-10 bg-[#0e0e0e]/95 backdrop-blur-sm border-b border-[#1e1e1e] -mx-4 px-4 pb-0 pt-0">
        <div className="hidden sm:flex items-center gap-1 px-1 pt-2 text-[10px] text-[#666] overflow-x-auto scrollbar-none whitespace-nowrap">
          <Link href="/game-hub" className="hover:text-white">
            Game Hub
          </Link>
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="text-[#9e9e9e] truncate">{name}</span>
        </div>
        <div className="flex items-center gap-2 py-2 sm:py-3">
          <Link
            href="/game-hub"
            className="p-1.5 rounded-lg text-[#555] hover:text-[#9e9e9e] hover:bg-[#1e1e1e] transition-colors flex-shrink-0"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <span className="text-xl flex-shrink-0">{server?.icon ?? "🎮"}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold text-[#f2f2f2] truncate">
                {name}
              </h1>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full flex-shrink-0",
                    statusDot,
                  )}
                />
                <span
                  className={cn(
                    "text-xs capitalize hidden sm:block",
                    statusText,
                  )}
                >
                  {status}
                </span>
              </div>
            </div>
            <p className="hidden sm:block text-[10px] text-[#555]">
              {server?.description ||
                `${server?.gameType?.replace(/-/g, " ") ?? "Game"} Server`}
            </p>
            <div className="mt-1 hidden sm:flex flex-wrap gap-1.5 text-[10px]">
              {server?.imageVersion && (
                <span className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-0.5 text-[#9e9e9e]">
                  Version {server.imageVersion}
                </span>
              )}
              {server && !server.imagePinned && (
                <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">
                  Using latest tag
                </span>
              )}
              {(server?.groups ?? []).map((group) => (
                <span
                  key={group}
                  className="rounded-full border border-[#0078D4]/20 bg-[#0078D4]/10 px-2 py-0.5 text-[#7cc2ff]"
                >
                  {group}
                </span>
              ))}
            </div>
            {server?.podStartTime && (
              <p className="hidden sm:block text-[10px] text-[#4db3ff] mt-0.5">
                Last restart {timeAgo(server.podStartTime)}
              </p>
            )}
            {status === "stopped" && (
              <p className="hidden sm:block text-[10px] text-amber-300 mt-0.5">
                Server is stopped. Use Start to bring it online.
              </p>
            )}
          </div>
          {server && (
            <div className="flex items-center gap-1 flex-shrink-0">
              {connectionInfo && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(connectionInfo);
                    toast.success("Connection info copied");
                  }}
                  title={connectionInfo}
                  className="hidden sm:flex px-2 py-2 min-h-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg text-xs transition-colors max-w-[140px] truncate"
                >
                  {connectionInfo}
                </button>
              )}
              <button
                onClick={async () => {
                  try {
                    await fetchJson(`/api/game-hub/servers/${name}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "set-maintenance",
                        enabled: !server.maintenanceMode,
                      }),
                    });
                    toast.success(
                      server.maintenanceMode
                        ? "Maintenance mode disabled"
                        : "Maintenance mode enabled",
                    );
                    queryClient.invalidateQueries({
                      queryKey: ["game-hub", "server", name],
                    });
                    queryClient.invalidateQueries({
                      queryKey: ["game-hub", "servers"],
                    });
                  } catch (error) {
                    toast.error(String(error));
                  }
                }}
                title={
                  server.maintenanceMode
                    ? "Exit Maintenance"
                    : "Enter Maintenance"
                }
                className={cn(
                  "group flex items-center gap-1.5 px-2.5 py-2 min-h-[38px] rounded-lg text-xs transition-all border",
                  server.maintenanceMode
                    ? "bg-yellow-500/20 border-yellow-400/40 text-yellow-100 shadow-[0_0_18px_rgba(250,204,21,0.22)]"
                    : "bg-[#1a1a1a] border-[#2a2a2a] hover:bg-yellow-500/10 hover:border-yellow-500/30 text-[#888] hover:text-yellow-200",
                )}
              >
                <Wrench className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Maintenance</span>
              </button>
              <button
                onClick={async () => {
                  const newName = prompt("Clone server as", `${name}-copy`);
                  if (!newName) return;
                  try {
                    await fetchJson("/api/game-hub/servers", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "clone",
                        source: name,
                        newName,
                      }),
                    });
                    toast.success("Clone started");
                    queryClient.invalidateQueries({
                      queryKey: ["game-hub", "servers"],
                    });
                  } catch (error) {
                    toast.error(String(error));
                  }
                }}
                className="hidden sm:flex px-3 py-2 min-h-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg text-xs transition-colors"
              >
                Clone
              </button>
              {status === "stopped" ? (
                <button
                  onClick={() => doAction("start")}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 px-3 py-2 min-h-[38px] bg-green-500/20 hover:bg-green-500/30 text-green-300 border border-green-500/30 rounded-lg text-xs font-medium disabled:opacity-50 touch-manipulation"
                >
                  {actionLoading === "start" ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}{" "}
                  Start
                </button>
              ) : (
                <>
                  <button
                    onClick={() => doAction("restart")}
                    disabled={!!actionLoading}
                    title="Quick restart"
                    className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center"
                  >
                    {actionLoading === "restart" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => doAction("stop")}
                    disabled={!!actionLoading}
                    title="Stop"
                    className="p-2 min-h-[38px] min-w-[38px] bg-[#1a1a1a] hover:bg-[#222] text-[#888] rounded-lg transition-colors disabled:opacity-50 touch-manipulation flex items-center justify-center"
                  >
                    {actionLoading === "stop" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-0 overflow-x-auto scrollbar-none touch-pan-x pb-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex items-center gap-1.5 px-3 sm:px-4 py-1.5 sm:py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px whitespace-nowrap flex-shrink-0 touch-manipulation",
                activeTab === id
                  ? "border-[#0078D4] text-[#0078D4] bg-[#0078D4]/5"
                  : "border-transparent text-[#555] hover:text-[#888]",
              )}
            >
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
              <p className="text-sm font-semibold text-red-300">
                Could not load server details
              </p>
              <p className="text-xs text-red-400/80 mt-1 font-mono">
                {String(error)}
              </p>
              <button
                onClick={() => refetch()}
                className="mt-3 flex items-center gap-1.5 text-xs text-red-300 hover:underline"
              >
                <RefreshCw className="w-3 h-3" /> Retry
              </button>
            </div>
          </div>
        )}

        {server && !isLoading && (
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {activeTab === "dashboard" && (
                <DashboardTab server={server} name={name} />
              )}
              {activeTab === "console" && (
                <ConsoleTab name={name} status={status} server={server} />
              )}
              {activeTab === "players" && (
                <PlayersTab name={name} server={server} />
              )}
              {activeTab === "files" && (
                <FilesTab name={name} status={status} mountPath={mountPath} />
              )}
              {activeTab === "activity" && <ActivityTab name={name} />}
              {activeTab === "settings" && (
                <SettingsTab name={name} server={server} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
