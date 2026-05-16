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
  ChevronDown,
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
  MoreHorizontal,
} from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { getEggForGameType } from "@/lib/game-eggs";
import { toast } from "@/lib/notify";
import Link from "next/link";
// Note: previously used Monaco editor; replaced with styled <textarea> + <pre>
// for instant load + no CDN dependency on Monaco worker scripts.
import { ActivityTab as ActivityTabFeature } from "@/components/game-hub/server-detail/activity-tab";
import { BanList } from "@/components/game-hub/server-detail/ban-list";
import { ConfigEditor } from "@/components/game-hub/server-detail/config-editor";
import { DashboardTab as DashboardTabFeature } from "@/components/game-hub/server-detail/dashboard-tab";
import { EnvTableEditor } from "@/components/game-hub/server-detail/env-table-editor";
import { MiniOverviewDrawer } from "@/components/game-hub/server-detail/mini-overview-drawer";
import { NotesTagsEditor } from "@/components/game-hub/server-detail/notes-tags-editor";
import { OpsManager } from "@/components/game-hub/server-detail/ops-manager";
import { PlayersTab as PlayersTabFeature } from "@/components/game-hub/server-detail/players-tab";
import { RconPanel } from "@/components/game-hub/server-detail/rcon-panel";
import { WhitelistManager } from "@/components/game-hub/server-detail/whitelist-manager";
import { WorldInfo } from "@/components/game-hub/server-detail/world-info";
import type {
  ConnectivityDetails,
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
type ConsoleHistoryDepth = "1h" | "6h" | "1d" | "3d" | "7d";
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
      historyDepth: ConsoleHistoryDepth;
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
      historyDepth: ConsoleHistoryDepth;
    }>;
  }
}

const HISTORY_DEPTH_MAX_LINES: Record<ConsoleHistoryDepth, number> = {
  "1h": 2000,
  "6h": 5000,
  "1d": 10000,
  "3d": 20000,
  "7d": 20000,
};
const GAME_HUB_TAB_STORAGE_PREFIX = "infraweaver:game-hub:tab";

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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function parseCpuMillicores(value: string | null | undefined) {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return 1000;
  if (trimmed.endsWith("m")) {
    return clampNumber(Number.parseInt(trimmed.slice(0, -1), 10) || 1000, 100, 4000);
  }
  return clampNumber(Math.round((Number.parseFloat(trimmed) || 1) * 1000), 100, 4000);
}

function parseMemoryMi(value: string | null | undefined) {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return 2048;
  const numeric = Number.parseFloat(trimmed.replace(/[^\d.]/g, "")) || 2048;
  if (trimmed.endsWith("gi") || trimmed.endsWith("g")) {
    return clampNumber(Math.round(numeric * 1024), 256, 8192);
  }
  if (trimmed.endsWith("ki") || trimmed.endsWith("k")) {
    return clampNumber(Math.round(numeric / 1024), 256, 8192);
  }
  return clampNumber(Math.round(numeric), 256, 8192);
}

function sliderTrackStyle(value: number, min: number, max: number) {
  const percent = ((clampNumber(value, min, max) - min) / Math.max(max - min, 1)) * 100;
  return {
    background: `linear-gradient(90deg, #34d399 0%, #facc15 70%, #f87171 100%), linear-gradient(90deg, #34d399 0%, #34d399 ${percent}%, #1a1a1a ${percent}%, #1a1a1a 100%)`,
    backgroundBlendMode: "screen, normal",
  } as const;
}

function thresholdTone(value: number, max: number) {
  const ratio = max > 0 ? value / max : 0;
  if (ratio >= 0.85) return { color: "#f87171", text: "text-red-300", bg: "bg-red-500/10" };
  if (ratio >= 0.6) return { color: "#facc15", text: "text-yellow-300", bg: "bg-yellow-500/10" };
  return { color: "#34d399", text: "text-emerald-300", bg: "bg-emerald-500/10" };
}

function ThresholdPreview({
  label,
  value,
  max,
  suffix,
}: {
  label: string;
  value: number;
  max: number;
  suffix: string;
}) {
  const percent = clampNumber((value / Math.max(max, 1)) * 100, 0, 100);
  const tone = thresholdTone(value, max);
  return (
    <div className={cn("rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3", tone.bg)}>
      <div className="flex items-center gap-3">
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-full"
          style={{
            background: `conic-gradient(${tone.color} 0 ${percent}%, #1f1f1f ${percent}% 100%)`,
          }}
        >
          <div className="absolute inset-[5px] rounded-full bg-[#111]" />
          <span className={cn("relative text-xs font-semibold", tone.text)}>
            {value}
            {suffix}
          </span>
        </div>
        <div>
          <p className="text-xs font-medium text-[#f2f2f2]">{label}</p>
          <p className="text-[10px] text-[#666]">Preview trigger ring</p>
        </div>
      </div>
    </div>
  );
}

function isSensitiveEnvName(name: string) {
  return /pass|secret|token|key|pwd|credential/i.test(name);
}

type BackupSchedulePreset = "disabled" | "hourly" | "every-6h" | "daily" | "weekly" | "custom";

const BACKUP_SCHEDULE_PRESETS: Array<{ id: BackupSchedulePreset; label: string; cron: string }> = [
  { id: "disabled", label: "Disabled", cron: "" },
  { id: "hourly", label: "Hourly", cron: "0 * * * *" },
  { id: "every-6h", label: "Every 6h", cron: "0 */6 * * *" },
  { id: "daily", label: "Daily", cron: "0 4 * * *" },
  { id: "weekly", label: "Weekly", cron: "0 4 * * 0" },
  { id: "custom", label: "Custom", cron: "" },
];

function detectBackupSchedulePreset(value: string | null | undefined): BackupSchedulePreset {
  const cron = (value ?? "").trim();
  if (!cron) return "disabled";
  if (cron === "0 * * * *") return "hourly";
  if (cron === "0 */6 * * *") return "every-6h";
  if (cron === "0 4 * * *") return "daily";
  if (cron === "0 4 * * 0") return "weekly";
  return "custom";
}

function parseCronPart(part: string, min: number, max: number) {
  const values = new Set<number>();
  if (part === "*") {
    for (let value = min; value <= max; value += 1) values.add(value);
    return values;
  }
  for (const token of part.split(",")) {
    const [rangePart, stepPart] = token.split("/");
    const step = Math.max(1, Number.parseInt(stepPart ?? "1", 10) || 1);
    if (rangePart === "*") {
      for (let value = min; value <= max; value += step) values.add(value);
      continue;
    }
    const [startRaw, endRaw] = rangePart.split("-");
    const start = clampNumber(Number.parseInt(startRaw, 10) || min, min, max);
    const end = clampNumber(Number.parseInt(endRaw ?? startRaw, 10) || start, min, max);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function matchesCronDate(date: Date, cronExpr: string) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    parseCronPart(minute, 0, 59).has(date.getMinutes()) &&
    parseCronPart(hour, 0, 23).has(date.getHours()) &&
    parseCronPart(dayOfMonth, 1, 31).has(date.getDate()) &&
    parseCronPart(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronPart(dayOfWeek, 0, 6).has(date.getDay())
  );
}

function nextCronRuns(cronExpr: string, count = 3) {
  const runs: Date[] = [];
  const expr = cronExpr.trim();
  if (!expr || expr.split(/\s+/).length !== 5) return runs;
  const cursor = new Date();
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  let attempts = 0;
  while (runs.length < count && attempts < 525600) {
    if (matchesCronDate(cursor, expr)) {
      runs.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
    attempts += 1;
  }
  return runs;
}

function highlightLogMatch(text: string, query: string) {
  if (!query.trim()) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let start = 0;
  let index = lowerText.indexOf(lowerQuery);
  while (index >= 0) {
    if (index > start) {
      parts.push(text.slice(start, index));
    }
    parts.push(
      <mark
        key={`${index}-${start}`}
        className="rounded-sm bg-yellow-500/30 text-yellow-200"
      >
        {text.slice(index, index + lowerQuery.length)}
      </mark>,
    );
    start = index + lowerQuery.length;
    index = lowerText.indexOf(lowerQuery, start);
  }
  if (start < text.length) {
    parts.push(text.slice(start));
  }
  return parts;
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
  connectivity,
}: {
  server: ServerDetail;
  name: string;
  connectivity?: ConnectivityDetails;
}) {
  return <DashboardTabFeature name={name} server={server} connectivity={connectivity} />;
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
  const [logSearch, setLogSearch] = useState("");
  const [logFilterMode, setLogFilterMode] = useState(true);
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
  const [historyDepth, setHistoryDepth] = useState<ConsoleHistoryDepth>(
    () => (readConsolePrefs().historyDepth as ConsoleHistoryDepth) ?? "1d",
  );
  // Mobile: collapse secondary console chrome to give log area max space
  const [showConsoleOptions, setShowConsoleOptions] = useState(false);
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [showCommandsPanel, setShowCommandsPanel] = useState(false);
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
  const connectRef = useRef<(depth?: ConsoleHistoryDepth) => void>(() => undefined);
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftCommandRef = useRef("");
  // Tracks seen log keys to avoid showing duplicate lines when SSE reconnects + replays history
  const seenLogKeysRef = useRef(new Set<string>());
  // Prevents adding multiple "Live logs" markers across reconnects
  const historyEndSeenRef = useRef(false);

  const eggCommands = normalizeQuickCommands(server.egg?.quickCommands);
  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const isConnected = status !== "stopped" && connected;
  const canStartServer = server.permissions?.canStart ?? true;
  const maxLines = HISTORY_DEPTH_MAX_LINES[historyDepth];

  const addLine = useCallback(
    (type: string, line: string, timestamp?: string | null) => {
      setLogLines((prev) => [
        ...prev.slice(-(maxLines - 1)),
        { type, line, timestamp, id: logIdRef.current++ },
      ]);
    },
    [maxLines],
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
          historyDepth,
        }),
      );
    } catch {
      // ignore
    }
  }, [autoScroll, historyDepth, levelFilter, regexMode, showTimestamps, wordWrap]);

  useEffect(() => {
    setLogLines((prev) => prev.slice(-maxLines));
  }, [maxLines]);

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

  const connect = useCallback((depthOverride?: ConsoleHistoryDepth) => {
    if (status === "stopped") return;
    if (retryRef.current) clearTimeout(retryRef.current);
    esRef.current?.close();

    // When user explicitly changes history depth, reset dedup state for a clean slate
    if (depthOverride !== undefined) {
      seenLogKeysRef.current.clear();
      historyEndSeenRef.current = false;
      lastLogTimestampRef.current = null;
    }

    const params = new URLSearchParams();
    const depth = depthOverride ?? historyDepth;
    const capLines = Math.min(HISTORY_DEPTH_MAX_LINES[depth] ?? 500, 2000);
    params.set("tail", String(capLines));
    if (lastLogTimestampRef.current) {
      params.set("sinceTime", lastLogTimestampRef.current);
    }

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

        if (msg.type === "history-end") {
          // Only add the marker once across all reconnects to prevent "LIVE LOGS" spam
          if (!historyEndSeenRef.current) {
            historyEndSeenRef.current = true;
          }
          // Don't render a visual divider — logs flow as one continuous stream
          return;
        }

        if ((msg.type === "log" || msg.type === "error") && msg.line) {
          const lineTimestamp =
            msg.timestamp ??
            msg.line.match(ISO_TIMESTAMP_PREFIX)?.[0]?.trim() ??
            null;
          if (lineTimestamp) lastLogTimestampRef.current = lineTimestamp;
          const cleanLine = msg.line.replace(ISO_TIMESTAMP_PREFIX, "");
          const content = cleanLine || msg.line;

          // Filter noisy lines that clutter the console
          const isNoise =
            /Thread RCON Client .+(started|shutting down)/i.test(content) ||
            /^\s*$/.test(content);
          if (isNoise) return;

          // Deduplicate: SSE replays history on every reconnect — skip already-seen lines
          const dedupeKey = `${lineTimestamp ?? ""}|${content.slice(0, 120)}`;
          if (seenLogKeysRef.current.has(dedupeKey)) return;
          seenLogKeysRef.current.add(dedupeKey);
          // Prevent the seen-set from growing unboundedly
          if (seenLogKeysRef.current.size > 5000) {
            const iter = seenLogKeysRef.current.values();
            for (let i = 0; i < 1000; i++) {
              const { value, done } = iter.next();
              if (done) break;
              seenLogKeysRef.current.delete(value);
            }
          }

          addLine(
            msg.type === "error" ? "error" : "log",
            content,
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
  }, [addLine, historyDepth, name, showBanner, status]);

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
        setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setLogSearch("");
        searchRef.current?.blur();
      }
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
      const body: Record<string, unknown> = { action: "delete-saved-command" };
      if (entry.id) {
        body.commandId = entry.id;
      } else {
        // Legacy commands without IDs — match by label+cmd
        body.commandLabel = entry.label;
        body.commandCmd = entry.cmd ?? entry.command ?? "";
      }
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      "history-marker": "text-[#7c8ba1]",
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
    (entry: { type?: string; line: string; timestamp?: string | null }) => {
      if (entry.type === "history-marker") return entry.line;
      if (!showTimestamps || !entry.timestamp) return entry.line;
      return `${entry.timestamp} ${entry.line}`;
    },
    [showTimestamps],
  );
  const visibleLogLines = useMemo(
    () =>
      logLines.filter((entry) => {
        if (entry.type === "history-marker") return true;
        if (levelFilter === "all") return true;
        return detectLogLevel(entry.type, entry.line) === levelFilter;
      }),
    [detectLogLevel, levelFilter, logLines],
  );
  const normalizedLogSearch = logSearch.trim().toLowerCase();
  const lineMatchesSearch = useCallback(
    (entry: { line: string; timestamp?: string | null }) => {
      if (!normalizedLogSearch) return false;
      return renderedLine(entry).toLowerCase().includes(normalizedLogSearch);
    },
    [normalizedLogSearch, renderedLine],
  );
  const matchingLineIds = useMemo(
    () =>
      normalizedLogSearch
        ? visibleLogLines
            .filter((line) => lineMatchesSearch(line))
            .map((line) => line.id)
        : [],
    [lineMatchesSearch, normalizedLogSearch, visibleLogLines],
  );
  const displayedLogLines = useMemo(() => {
    if (!normalizedLogSearch || !logFilterMode) return visibleLogLines;
    return visibleLogLines.filter((line) => lineMatchesSearch(line));
  }, [lineMatchesSearch, logFilterMode, normalizedLogSearch, visibleLogLines]);
  const handleConsoleScroll = () => {
    const element = consoleRef.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    setAutoScroll(nearBottom);
  };

  return (
    <div className="flex h-[calc(100dvh-170px)] min-h-[65vh] flex-col overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#0a0a0a] sm:h-[calc(100dvh-280px)] sm:min-h-[360px]">
      {/* ── Toolbar ── */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[#1e1e1e] bg-[#111] px-3 py-2">
        {/* Status — always visible */}
        <Circle className={cn("w-2 h-2 flex-shrink-0", isConnected ? "fill-green-400 text-green-400" : "fill-[#444] text-[#444]")} />
        <span className={cn("min-w-0 flex-1 truncate text-xs", isConnected ? "text-green-400" : "text-[#555]")}>
          {isConnected ? podLabel : status === "stopped" ? "Server stopped" : "Connecting…"}
        </span>

        {/* Mobile: 3 compact icon buttons (search · options · clear) */}
        <div className="flex items-center gap-0.5 sm:hidden">
          {!isConnected && status !== "stopped" && (
            <button onClick={() => { retryCountRef.current = 0; connectRef.current(); }}
              className="min-h-[36px] px-2 text-xs text-[#0078D4] hover:underline">↺</button>
          )}
          <button onClick={() => { setShowMobileSearch(v => !v); if (!showMobileSearch) setTimeout(() => searchRef.current?.focus(), 50); }}
            className={cn("min-h-[36px] rounded p-2 transition-colors", showMobileSearch ? "text-[#4db3ff] bg-[#0078D4]/10" : "text-[#555] hover:text-[#888] hover:bg-[#1e1e1e]")}>
            <Search className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setLogLines([])} title="Clear"
            className="min-h-[36px] rounded p-2 text-[#555] transition-colors hover:text-[#888] hover:bg-[#1e1e1e]">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setShowConsoleOptions(v => !v)}
            className={cn("min-h-[36px] rounded p-2 transition-colors", showConsoleOptions ? "text-[#4db3ff] bg-[#0078D4]/10" : "text-[#555] hover:text-[#888] hover:bg-[#1e1e1e]")}>
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Desktop: all controls */}
        <div className="hidden items-center gap-2 sm:flex">
          {!isConnected && status !== "stopped" && (
            <button onClick={() => { retryCountRef.current = 0; connectRef.current(); }}
              className="min-h-[36px] text-xs text-[#0078D4] hover:underline">Reconnect</button>
          )}
          {[
            { label: autoScroll ? "Auto-scroll on" : "Auto-scroll off", active: autoScroll, toggle: () => setAutoScroll(v => !v) },
            { label: "Timestamps", active: showTimestamps, toggle: () => setShowTimestamps(v => !v) },
            { label: "Wrap", active: wordWrap, toggle: () => setWordWrap(v => !v) },
          ].map(({ label, active, toggle }) => (
            <button key={label} onClick={toggle}
              className={cn("min-h-[36px] rounded-md border px-2 py-1 text-[10px] transition-colors",
                active ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>
              {label}
            </button>
          ))}
          <select value={historyDepth} onChange={(e) => { const d = e.target.value as ConsoleHistoryDepth; setHistoryDepth(d); lastLogTimestampRef.current = null; setLogLines([]); connect(d); }}
            className="min-h-[36px] cursor-pointer rounded border border-[#2a2a2a] bg-[#1a1a1a] px-1.5 py-0.5 text-[10px] text-[#888]">
            <option value="1h">1h</option><option value="6h">6h</option>
            <option value="1d">1d</option><option value="3d">3d</option><option value="7d">7d</option>
          </select>
          <button onClick={() => searchRef.current?.focus()} className="min-h-[36px] rounded p-1.5 text-[#444] hover:bg-[#1e1e1e] hover:text-[#888]"><Search className="w-3.5 h-3.5" /></button>
          {[
            { icon: RefreshCw, label: "Clear", action: () => setLogLines([]) },
            { icon: Copy, label: "Copy all", action: () => { navigator.clipboard.writeText(displayedLogLines.map(l => renderedLine(l)).join("\n")); toast.success("Copied"); } },
            { icon: Download, label: "Download logs", action: () => downloadTextFile(`${name}-console-${new Date().toISOString().slice(0, 10)}.txt`, displayedLogLines.map(l => renderedLine(l)).join("\n")) },
          ].map(({ icon: Icon, label, action }) => (
            <button key={label} onClick={action} title={label} className="min-h-[36px] rounded p-1.5 text-[#444] hover:bg-[#1e1e1e] hover:text-[#888]"><Icon className="w-3.5 h-3.5" /></button>
          ))}
        </div>
      </div>

      {/* Mobile options panel (toggleable) */}
      {showConsoleOptions && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[#1e1e1e] bg-[#0d0d0d] px-3 py-2 sm:hidden">
          {[
            { label: autoScroll ? "Auto ✓" : "Auto-scroll", active: autoScroll, toggle: () => setAutoScroll(v => !v) },
            { label: showTimestamps ? "Time ✓" : "Timestamps", active: showTimestamps, toggle: () => setShowTimestamps(v => !v) },
            { label: wordWrap ? "Wrap ✓" : "Wrap", active: wordWrap, toggle: () => setWordWrap(v => !v) },
          ].map(({ label, active, toggle }) => (
            <button key={label} onClick={toggle}
              className={cn("rounded-full border px-3 py-1 text-[10px] transition-colors",
                active ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-[#2a2a2a] text-[#777]")}>
              {label}
            </button>
          ))}
          <select value={historyDepth} onChange={(e) => { const d = e.target.value as ConsoleHistoryDepth; setHistoryDepth(d); lastLogTimestampRef.current = null; setLogLines([]); connect(d); }}
            className="cursor-pointer rounded-full border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1 text-[10px] text-[#888]">
            <option value="1h">1h history</option><option value="6h">6h history</option>
            <option value="1d">1d history</option><option value="3d">3d history</option><option value="7d">7d history</option>
          </select>
          <button onClick={() => { navigator.clipboard.writeText(displayedLogLines.map(l => renderedLine(l)).join("\n")); toast.success("Copied"); }}
            className="rounded-full border border-[#2a2a2a] px-3 py-1 text-[10px] text-[#777]">Copy all</button>
          <button onClick={() => downloadTextFile(`${name}-console-${new Date().toISOString().slice(0, 10)}.txt`, displayedLogLines.map(l => renderedLine(l)).join("\n"))}
            className="rounded-full border border-[#2a2a2a] px-3 py-1 text-[10px] text-[#777]">Download</button>
        </div>
      )}

      {/* Search bar — always on desktop, toggle-shown on mobile */}
      <div className={cn(
        "flex flex-wrap items-center gap-2 px-4 py-2 border-b border-[#1e1e1e] bg-[#101010]",
        !showMobileSearch && "hidden sm:flex",
        showMobileSearch && "flex",
      )}>
        <div className="flex min-w-0 basis-full flex-1 items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-3 py-2 sm:min-w-[220px] sm:basis-auto">
          <Search className="h-3.5 w-3.5 text-[#666]" />
          <input
            ref={searchRef}
            value={logSearch}
            onChange={(event) => setLogSearch(event.target.value)}
            placeholder="Search logs…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[#f2f2f2] outline-none"
          />
          {logSearch && (
            <button
              onClick={() => setLogSearch("")}
              className="min-h-[36px] rounded p-1 text-[#666] hover:bg-[#1a1a1a] hover:text-[#f2f2f2]"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <span className="rounded-full border border-[#2a2a2a] bg-[#0d0d0d] px-2.5 py-1 text-[11px] text-[#bbb]">
          {matchingLineIds.length} matches
        </span>
        <button
          onClick={() => setLogFilterMode((value) => !value)}
          className={cn(
            "min-h-[36px] rounded-lg border px-3 py-1.5 text-[11px] transition-colors",
            logFilterMode
              ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]"
              : "border-[#2a2a2a] bg-[#0d0d0d] text-[#888]",
          )}
        >
          {logFilterMode ? "Filter mode" : "Dim mode"}
        </button>
        <select
          value={levelFilter}
          onChange={(event) =>
            setLevelFilter(
              event.target.value as "all" | "error" | "warn" | "info",
            )
          }
          className="min-h-[36px] rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1.5 text-[10px] text-[#bbb] focus:outline-none"
        >
          <option value="all">All levels</option>
          <option value="error">ERROR</option>
          <option value="warn">WARN</option>
          <option value="info">INFO</option>
        </select>
      </div>

      {reconnectBanner && status !== "stopped" && (
        <div className="px-4 py-1.5 border-b border-[#1e1e1e] bg-[#111827] text-[11px] text-[#93c5fd]">
          {reconnectBanner}
        </div>
      )}

      {logLines.length >= maxLines && (
        <div className="px-4 py-1.5 border-b border-[#3a2a00] bg-yellow-500/10 text-[11px] text-yellow-200">
          ⚠ Display capped at {maxLines} lines
        </div>
      )}

      <div
        ref={consoleRef}
        onScroll={handleConsoleScroll}
        className="flex-1 overflow-y-auto overflow-x-auto touch-pan-y px-3 py-3 font-mono text-xs leading-[1.7] overscroll-contain select-text sm:p-4"
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
        ) : displayedLogLines.length === 0 ? (
          <div className="flex items-center gap-2 text-[#444] pt-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>
              {logLines.length === 0
                ? "Connecting to log stream…"
                : "No logs match the current filters."}
            </span>
          </div>
        ) : (
          displayedLogLines.map((entry) => (
            entry.type === "history-marker" ? (
              // History-marker is kept in logLines for dedup tracking but renders nothing
              <span key={entry.id} style={{ display: "none" }} aria-hidden="true" />
            ) : (
              <div
                key={entry.id}
                ref={(element) => {
                  lineRefs.current[entry.id] = element;
                }}
                className={cn(
                  wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                  "px-1 rounded min-w-fit transition-opacity",
                  lineColor(entry.type),
                  normalizedLogSearch && !logFilterMode && !matchingLineIds.includes(entry.id) && "opacity-35",
                  matchingLineIds.includes(entry.id) && "bg-yellow-400/10",
                )}
              >
                {highlightLogMatch(renderedLine(entry), logSearch)}
              </div>
            )
          ))
        )}
        <div ref={logEndRef} />
      </div>

      {isConnected && (eggCommands.length > 0 || savedCommands.length > 0) && (
        <div className="flex-shrink-0 border-t border-[#1a1a1a] bg-[#0d0d0d]">
          {/* Mobile: collapse toggle */}
          <button
            onClick={() => setShowCommandsPanel(v => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-[10px] text-[#555] transition-colors hover:text-[#888] sm:hidden"
          >
            <span className="uppercase tracking-wide">
              Commands ({eggCommands.length + savedCommands.length})
            </span>
            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform duration-200", showCommandsPanel && "rotate-180")} />
          </button>

          {/* Content — always visible desktop, toggle on mobile */}
          <div className={cn("space-y-3 px-3 py-2", !showCommandsPanel && "hidden sm:block")}>
            {eggCommands.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">Quick Commands</p>
                <div className="overflow-x-auto scrollbar-none">
                  <div className="flex w-max gap-2 pb-1">
                    {eggCommands.map((entry) => (
                      <button key={`${entry.label}-${entry.command}`}
                        onClick={() => { setCommand(entry.command); inputRef.current?.focus(); }}
                        className="min-h-[36px] rounded-full border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1 text-[10px] text-[#777] transition-colors hover:bg-[#252525] hover:text-[#ccc]">
                        {entry.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {savedCommands.length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-[#444] mb-2">Saved Commands</p>
                <div className="overflow-x-auto scrollbar-none">
                  <div className="flex w-max gap-2 pb-1">
                    {savedCommands.map((entry) => (
                      <div key={`${entry.id ?? entry.label}-${entry.command}`}
                        className="flex items-center overflow-hidden rounded-full border border-[#2a2a2a] bg-[#1a1a1a]">
                        <button onClick={() => { setCommand(entry.command ?? ""); inputRef.current?.focus(); }}
                          className="min-h-[36px] px-3 py-1 text-[10px] text-[#777] transition-colors hover:bg-[#252525] hover:text-[#ccc]">
                          {entry.label}
                        </button>
                        <button onClick={() => deleteSavedCommand(entry)}
                          className="min-h-[36px] px-2 py-1 text-[10px] text-[#555] transition-colors hover:bg-red-500/10 hover:text-red-300">
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="sticky bottom-0 z-10 flex-shrink-0 border-t border-[#1a1a1a] bg-[#0d0d0d]/95 p-2 backdrop-blur supports-[backdrop-filter]:bg-[#0d0d0d]/85 pb-[calc(env(safe-area-inset-bottom,0px)+0.5rem)]">
        {/* No extra row on mobile — save icon is inside the input bar */}
        <form onSubmit={sendCommand} className="flex items-center gap-2">
          <div
            className={cn(
              "flex min-h-[46px] flex-1 items-center gap-2 rounded-xl border bg-[#111] px-3",
              isConnected
                ? "border-[#2a2a2a] focus-within:border-[#0078D4]"
                : "border-[#1a1a1a] opacity-50",
            )}
          >
            <span className="select-none font-mono text-sm text-green-500">❯</span>
            <input
              ref={inputRef}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? "Enter command… (↑↓ history)" : "Waiting for connection…"}
              disabled={!isConnected || sending}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 bg-transparent py-1 font-mono text-[16px] leading-none text-[#f0f0f0] outline-none placeholder:text-[#333] disabled:cursor-not-allowed"
            />
            {/* Save command icon — shown on mobile inside input bar */}
            <button type="button" onClick={saveCurrentCommand} disabled={!command.trim()}
              title="Save command"
              className="min-h-[36px] rounded p-1 text-[#444] transition-colors hover:text-[#888] disabled:opacity-30 sm:hidden">
              <Save className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={saveCurrentCommand}
            disabled={!command.trim()}
            className="hidden min-h-[46px] rounded-xl bg-[#1a1a1a] px-3 text-xs font-medium text-[#cfcfcf] transition-colors hover:bg-[#252525] disabled:opacity-40 sm:inline-flex sm:items-center"
          >
            Save
          </button>
          <button
            type="button"
            onClick={clearCommandHistory}
            disabled={history.length === 0}
            className="hidden min-h-[46px] rounded-xl bg-[#1a1a1a] px-3 text-xs font-medium text-[#9e9e9e] transition-colors hover:bg-[#252525] disabled:opacity-40 sm:inline-flex sm:items-center"
          >
            Clear History
          </button>
          <button
            type="submit"
            disabled={!isConnected || sending || !command.trim()}
            className="inline-flex min-h-[46px] items-center justify-center rounded-xl bg-[#0078D4] px-4 text-sm font-medium text-white transition-colors touch-manipulation hover:bg-[#0065B3] disabled:opacity-25 sm:h-11 sm:w-11 sm:px-0"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                <Send className="w-4 h-4 sm:hidden" />
                <span className="hidden sm:inline">Send</span>
                <Send className="hidden w-4 h-4 sm:inline" />
              </>
            )}
          </button>
        </form>
        <p className="mt-1.5 px-1 text-[10px] text-[#2a2a2a]">
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
  const [fileTooLarge, setFileTooLarge] = useState<{ size: number } | null>(null);
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
      setFileTooLarge(null);
      originalContentRef.current = null;
      return;
    }

    setDiffOpen(false);
    setSelectedFile(entry);
    setFileContent(null);
    setFileTooLarge(null);
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
      const res = await fetch(
        `/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(entry.path)}`,
        { signal: controller.signal },
      );
      if (res.status === 413) {
        const body = await res.json().catch(() => ({})) as { size?: number };
        setFileTooLarge({ size: body.size ?? 0 });
        setLoadingContent(false);
        clearTimeout(timer);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const result = await res.json() as { content: string };
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
            ) : fileTooLarge ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 bg-[#0a0a0a] p-4">
                <FileText className="w-10 h-10 text-[#444]" />
                <div className="text-center">
                  <p className="text-sm font-medium text-[#d4d4d4] mb-1">File too large to edit in browser</p>
                  <p className="text-xs text-[#555]">{fileTooLarge.size > 0 ? `${(fileTooLarge.size / 1024 / 1024).toFixed(1)} MB` : "Size unknown"} — max 50 MB for inline editing</p>
                </div>
                <a
                  href={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(selectedFile.path)}&download=1`}
                  download={selectedFile.name}
                  className="flex items-center gap-2 px-4 py-2 bg-[#0078D4] hover:bg-[#0065B3] text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" /> Download File
                </a>
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

function SettingsAccordion({
  title,
  description,
  children,
  defaultOpen = false,
}: {
  title: string;
  description?: string;
  children: import("react").ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="group overflow-hidden rounded-xl border border-[#2a2a2a] bg-[#111]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-[#f2f2f2]">{title}</p>
          {description ? <p className="text-xs text-[#888]">{description}</p> : null}
        </div>
        <ChevronDown className="h-4 w-4 text-[#555] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[#1e1e1e] p-4">{children}</div>
    </details>
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
  const eggEnvVars = server.egg?.environment ?? defaultEgg.environment ?? [];
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
  const [memLimit, setMemLimit] = useState(parseMemoryMi(server.memory));
  const [cpuLimit, setCpuLimit] = useState(parseCpuMillicores(server.cpu));
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
  const [backupSchedulePreset, setBackupSchedulePreset] = useState<BackupSchedulePreset>(
    detectBackupSchedulePreset(server.backupSchedule),
  );
  const [backupCronExpr, setBackupCronExpr] = useState(
    (server.backupSchedule ?? "").trim(),
  );
  const [backupRetention, setBackupRetention] = useState(
    server.backupRetention ?? 7,
  );
  const [savingBackupSchedule, setSavingBackupSchedule] = useState(false);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [commandLabel, setCommandLabel] = useState("");
  const [commandText, setCommandText] = useState("");
  const [unsetApplyState, setUnsetApplyState] = useState<Record<string, "loading" | "done" | undefined>>({});
  const [appliedUnsetEnv, setAppliedUnsetEnv] = useState<Record<string, string>>({});
  const [unsetEditValues, setUnsetEditValues] = useState<Record<string, string>>({});
  const isServerStopped = server.replicas === 0 || server.status === "stopped";
  const mountPath = server.egg?.mountPath ?? "/data";
  const isMinecraft = server.gameType.toLowerCase().includes("minecraft");
  const refreshServerDetails = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
    queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    queryClient.invalidateQueries({ queryKey: ["game-hub", "connectivity", name] });
  }, [name, queryClient]);
  const effectiveEnv = { ...currentEnv, ...appliedUnsetEnv };
  const unsetRecommendedEnvVars = eggEnvVars.filter((entry) => {
    const currentValue = effectiveEnv[entry.name]?.trim();
    return (entry.defaultValue.trim().length > 0 || entry.required) && !currentValue;
  });

  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const templateConfig = useMemo(
    () => ({
      gameType: server.gameType,
      image: server.image ?? "",
      cpu: server.cpu,
      memory: server.memory,
      port: server.port,
      env: Object.fromEntries(
        server.env
          .filter((entry) => !isSensitiveEnvName(entry.name))
          .map((entry) => [entry.name, entry.value ?? ""]),
      ),
      egg: server.gameType,
      notes: server.notes ?? "",
      tags: server.tags ?? [],
    }),
    [server],
  );
  const nextBackupRuns = useMemo(
    () => nextCronRuns(backupCronExpr, 3),
    [backupCronExpr],
  );
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
    refreshServerDetails();
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
    setSavingResources(true);
    try {
      await patchServer(
        {
          action: "update-resources",
          memory: `${memLimit}Mi`,
          cpu: `${cpuLimit}m`,
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

  async function saveBackupSchedule() {
    setSavingBackupSchedule(true);
    try {
      await patchServer(
        {
          action: "set-backup-schedule",
          cronExpr:
            backupSchedulePreset === "disabled"
              ? ""
              : backupSchedulePreset === "custom"
                ? backupCronExpr.trim()
                : backupCronExpr,
          retention: clampNumber(Math.round(backupRetention), 1, 365),
        },
        "Backup schedule saved",
      );
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSavingBackupSchedule(false);
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

  async function applyUnsetEnvVar(entry: { name: string; defaultValue: string }, customValue?: string) {
    const valueToApply = customValue ?? entry.defaultValue;
    setUnsetApplyState((prev) => ({ ...prev, [entry.name]: "loading" }));
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-env", env: { [entry.name]: valueToApply } }),
      });
      setUnsetApplyState((prev) => ({ ...prev, [entry.name]: "done" }));
      setTimeout(() => {
        setAppliedUnsetEnv((prev) => ({ ...prev, [entry.name]: valueToApply }));
        setUnsetApplyState((prev) => {
          const next = { ...prev };
          delete next[entry.name];
          return next;
        });
        queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
      }, 600);
    } catch (error) {
      setUnsetApplyState((prev) => {
        const next = { ...prev };
        delete next[entry.name];
        return next;
      });
      toast.error(String(error));
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

  function exportServer() {
    downloadTextFile(
      `${name}-config.json`,
      JSON.stringify(templateConfig, null, 2),
      "application/json",
    );
    toast.success("Server export downloaded");
  }

  function cloneServerFromTemplate() {
    window.location.href = `/game-hub/create?template=${encodeURIComponent(
      JSON.stringify(templateConfig),
    )}`;
  }

  return (
    <div className="space-y-4">
      {unsetRecommendedEnvVars.length > 0 && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <span className="text-sm font-medium text-yellow-300">Recommended settings not configured</span>
          </div>
          <div className="space-y-2">
            {unsetRecommendedEnvVars.map((entry) => {
              const state = unsetApplyState[entry.name];
              const editVal = unsetEditValues[entry.name] ?? entry.defaultValue;
              return (
                <div key={entry.name} className="rounded-lg border border-yellow-500/10 bg-[#111] px-3 py-2 space-y-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 font-mono text-[10px] text-yellow-100 mt-0.5">{entry.name}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-[#f2f2f2]">{entry.description || "Recommended setting"}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <input
                      type={/password|secret|token|key/i.test(entry.name) ? "password" : "text"}
                      value={editVal}
                      onChange={(e) => setUnsetEditValues((prev) => ({ ...prev, [entry.name]: e.target.value }))}
                      placeholder={entry.defaultValue || "Enter value…"}
                      className="flex-1 min-w-0 rounded-md bg-[#1a1a1a] border border-[#2a2a2a] px-2.5 py-1 text-xs text-[#d4d4d4] font-mono focus:outline-none focus:border-yellow-500/40 placeholder-[#444]"
                    />
                    <button
                      onClick={() => void applyUnsetEnvVar(entry, editVal)}
                      disabled={state === "loading" || !editVal}
                      className="inline-flex items-center gap-1 rounded-md border border-green-500/30 bg-green-500/15 px-2.5 py-1 text-[11px] text-green-200 transition-colors hover:bg-green-500/20 disabled:opacity-60 flex-shrink-0"
                    >
                      {state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>{state === "done" ? "✓ Applied" : "✓ Apply"}</span>}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
          <div className="flex flex-wrap gap-2">
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
                    className="flex h-11 w-11 items-center justify-center rounded bg-[#1e1e1e] text-sm font-bold text-[#888] hover:bg-[#2a2a2a] disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="min-w-[72px] text-center text-sm font-mono text-[#f2f2f2] sm:min-w-[92px]">
                    {isServerStopped ? "0 (stopped)" : staticCount}
                  </span>
                  <button
                    onClick={() =>
                      setStaticCount((count) => Math.min(10, count + 1))
                    }
                    disabled={isServerStopped}
                    className="flex h-11 w-11 items-center justify-center rounded bg-[#1e1e1e] text-sm font-bold text-[#888] hover:bg-[#2a2a2a] disabled:opacity-40"
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
        <div className="p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="block truncate text-sm text-[#f2f2f2]">Restart on crash</p>
              <p className="mt-0.5 truncate text-xs text-[#888]">
                Automatically restart if the server process exits unexpectedly
              </p>
            </div>
            <button
              onClick={toggleAutoRestart}
              disabled={savingRestart}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                autoRestart ? "bg-[#3b82f6]" : "bg-[#2a2a2a]",
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
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="block truncate text-sm text-[#f2f2f2]">Enable scheduled start</p>
                  <p className="truncate text-[11px] text-[#888]">Scale the server back to 1 replica on the selected days.</p>
                </div>
                <button
                  onClick={() => setScheduleStartEnabled((current) => !current)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                    scheduleStartEnabled ? "bg-[#3b82f6]" : "bg-[#2a2a2a]",
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
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="block truncate text-sm text-[#f2f2f2]">Enable scheduled stop</p>
                  <p className="truncate text-[11px] text-[#888]">Scale the server down cleanly at the chosen time.</p>
                </div>
                <button
                  onClick={() => setScheduleStopEnabled((current) => !current)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                    scheduleStopEnabled ? "bg-[#3b82f6]" : "bg-[#2a2a2a]",
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
              <label className="mb-2 block text-[10px] text-[#888]">Days of week</label>
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
              <label className="mb-2 block text-[10px] text-[#888]">Timezone</label>
              <input
                value={scheduleTimezone}
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="America/New_York"
                className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-3 py-2 text-sm text-[#f2f2f2] font-mono focus:outline-none focus:border-[#0078D4]"
              />
              <p className="mt-1 text-[10px] text-[#888]">CronJobs use this IANA timezone.</p>
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
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-[#666]">CPU threshold</label>
                <span className="text-xs text-[#f2f2f2]">{alertCpu}%</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={alertCpu}
                  onChange={(event) => setAlertCpu(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                  style={sliderTrackStyle(alertCpu, 0, 100)}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-[#1a1a1a]"
                />
                <div className="flex items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={alertCpu}
                    onChange={(event) => setAlertCpu(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                    className="w-12 bg-transparent text-right text-sm text-[#f2f2f2] outline-none"
                  />
                  <span className="text-xs text-[#666]">%</span>
                </div>
              </div>
              <ThresholdPreview label="CPU preview" value={alertCpu} max={100} suffix="%" />
            </div>
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-[#666]">Memory threshold</label>
                <span className="text-xs text-[#f2f2f2]">{alertMemory}%</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={alertMemory}
                  onChange={(event) => setAlertMemory(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                  style={sliderTrackStyle(alertMemory, 0, 100)}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-[#1a1a1a]"
                />
                <div className="flex items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={alertMemory}
                    onChange={(event) => setAlertMemory(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                    className="w-12 bg-transparent text-right text-sm text-[#f2f2f2] outline-none"
                  />
                  <span className="text-xs text-[#666]">%</span>
                </div>
              </div>
              <ThresholdPreview label="Memory preview" value={alertMemory} max={100} suffix="%" />
            </div>
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-[#666]">Restart threshold</label>
                <span className="text-xs text-[#f2f2f2]">{alertRestarts}</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={1}
                  value={alertRestarts}
                  onChange={(event) => setAlertRestarts(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 20))}
                  style={sliderTrackStyle(alertRestarts, 0, 20)}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-[#1a1a1a]"
                />
                <div className="rounded-lg border border-[#2a2a2a] bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={alertRestarts}
                    onChange={(event) => setAlertRestarts(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 20))}
                    className="w-12 bg-transparent text-right text-sm text-[#f2f2f2] outline-none"
                  />
                </div>
              </div>
              <ThresholdPreview label="Restart preview" value={alertRestarts} max={20} suffix="" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={saveAlertThresholds}
              disabled={savingThresholds || !server.permissions?.canAdmin}
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

      {server.permissions?.canAdmin && (
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
            <Cpu className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
              Resource Limits
            </p>
          </div>
          <div className="p-4 space-y-4">
            <p className="text-xs text-[#666]">
              Current applied limits: <span className="text-[#f2f2f2]">{server.cpu}</span> CPU and <span className="text-[#f2f2f2]">{server.memory}</span> memory.
            </p>
            <div className="space-y-3">
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[10px] uppercase tracking-wide text-[#666]">CPU</label>
                  <span className="text-sm text-[#f2f2f2]">{cpuLimit}m</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={100}
                    max={4000}
                    step={100}
                    value={cpuLimit}
                    onChange={(event) => setCpuLimit(clampNumber(Number.parseInt(event.target.value, 10) || 100, 100, 4000))}
                    style={sliderTrackStyle(cpuLimit, 100, 4000)}
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-[#1a1a1a]"
                  />
                  <div className="flex items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#111] px-2.5 py-1.5">
                    <input
                      type="number"
                      min={100}
                      max={4000}
                      step={100}
                      value={cpuLimit}
                      onChange={(event) => setCpuLimit(clampNumber(Number.parseInt(event.target.value, 10) || 100, 100, 4000))}
                      className="w-16 bg-transparent text-right text-sm text-[#f2f2f2] outline-none"
                    />
                    <span className="text-xs text-[#666]">m</span>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[10px] uppercase tracking-wide text-[#666]">Memory</label>
                  <span className="text-sm text-[#f2f2f2]">{memLimit} MB</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={256}
                    max={8192}
                    step={256}
                    value={memLimit}
                    onChange={(event) => setMemLimit(clampNumber(Number.parseInt(event.target.value, 10) || 256, 256, 8192))}
                    style={sliderTrackStyle(memLimit, 256, 8192)}
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-[#1a1a1a]"
                  />
                  <div className="flex items-center gap-1 rounded-lg border border-[#2a2a2a] bg-[#111] px-2.5 py-1.5">
                    <input
                      type="number"
                      min={256}
                      max={8192}
                      step={256}
                      value={memLimit}
                      onChange={(event) => setMemLimit(clampNumber(Number.parseInt(event.target.value, 10) || 256, 256, 8192))}
                      className="w-16 bg-transparent text-right text-sm text-[#f2f2f2] outline-none"
                    />
                    <span className="text-xs text-[#666]">MB</span>
                  </div>
                </div>
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
              )}
              Save Resource Limits
            </button>
          </div>
        </div>
      )}

      <div className="space-y-4">
        <EnvTableEditor serverName={name} env={server.env} onSave={refreshServerDetails} />

        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-[#1e1e1e]">
            <Shield className="w-3.5 h-3.5 text-[#555]" />
            <p className="text-xs font-medium text-[#888] uppercase tracking-wide">
              Config Diff vs Egg Defaults
            </p>
          </div>
          <div className="p-4">
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

        {isMinecraft ? (
          <div className="space-y-4">
            <SettingsAccordion
              title="World Info"
              description="Seed, world name, and key gameplay settings."
              defaultOpen
            >
              <WorldInfo serverName={name} mountPath={mountPath} gameType={server.gameType} />
            </SettingsAccordion>
            <SettingsAccordion
              title="RCON Console"
              description="Run remote console commands for the server."
            >
              <RconPanel serverName={name} gameType={server.gameType} permissions={server.permissions} />
            </SettingsAccordion>
            <SettingsAccordion
              title="Whitelist"
              description="Add or remove allowed players."
            >
              <WhitelistManager serverName={name} mountPath={mountPath} />
            </SettingsAccordion>
            <SettingsAccordion
              title="Operators"
              description="Manage Minecraft op levels and bypass permissions."
            >
              <OpsManager serverName={name} mountPath={mountPath} />
            </SettingsAccordion>
            <SettingsAccordion
              title="Ban List"
              description="Review banned players and IP addresses."
            >
              <BanList serverName={name} mountPath={mountPath} />
            </SettingsAccordion>
            <SettingsAccordion
              title="server.properties"
              description="Edit the main Minecraft server configuration file."
            >
              <ConfigEditor
                serverName={name}
                filePath={`${mountPath}/server.properties`}
                title="server.properties"
                gameType={server.gameType}
              />
            </SettingsAccordion>
          </div>
        ) : null}
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
            <div className="flex flex-wrap gap-2">
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
              <div className="flex flex-wrap gap-2">
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
              <div className="flex flex-wrap gap-2">
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
                className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_110px_110px_110px_auto] sm:items-center"
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
                  className="min-h-[44px] min-w-[44px] rounded-lg border border-[#2a2a2a] p-2 text-[#777] hover:text-red-300 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
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
            Backup Scheduler
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {BACKUP_SCHEDULE_PRESETS.map((preset) => {
              const active = backupSchedulePreset === preset.id;
              return (
                <button
                  key={preset.id}
                  onClick={() => {
                    setBackupSchedulePreset(preset.id);
                    if (preset.id === "custom") {
                      setBackupCronExpr((current) => current || "0 4 * * *");
                    } else {
                      setBackupCronExpr(preset.cron);
                    }
                  }}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    active
                      ? "border-[#0078D4]/40 bg-[#0078D4]/15 text-[#7cc2ff]"
                      : "border-[#2a2a2a] bg-[#0a0a0a] text-[#888] hover:text-[#f2f2f2]",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          {backupSchedulePreset === "custom" && (
            <div className="space-y-2 rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3">
              <label className="block text-[10px] uppercase tracking-wide text-[#666]">Cron expression</label>
              <input
                value={backupCronExpr}
                onChange={(event) => setBackupCronExpr(event.target.value)}
                placeholder="0 4 * * *"
                className="w-full rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2 text-sm font-mono text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
              <p className="text-[10px] text-[#555]">Use a standard 5-field cron: minute hour day month weekday.</p>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-[1fr_180px]">
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3">
              <p className="text-[10px] uppercase tracking-wide text-[#666]">Next 3 run times</p>
              <div className="mt-2 space-y-1 text-sm text-[#f2f2f2]">
                {backupSchedulePreset === "disabled" ? (
                  <p className="text-xs text-[#666]">Backups are disabled.</p>
                ) : nextBackupRuns.length > 0 ? (
                  nextBackupRuns.map((runAt) => (
                    <div key={runAt.toISOString()} className="rounded-lg border border-[#1f1f1f] bg-[#111] px-3 py-2 text-xs">
                      {runAt.toLocaleString()}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-yellow-200">Unable to calculate runs for this cron expression.</p>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-[#2a2a2a] bg-[#0d0d0d] p-3 space-y-2">
              <label className="block text-[10px] uppercase tracking-wide text-[#666]">Retention (days)</label>
              <input
                type="number"
                min={1}
                max={365}
                value={backupRetention}
                onChange={(event) => setBackupRetention(clampNumber(Number.parseInt(event.target.value, 10) || 1, 1, 365))}
                className="w-full rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2 text-sm text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
              <p className="text-[10px] text-[#555]">Keep backups for this many days.</p>
            </div>
          </div>
          <button
            onClick={saveBackupSchedule}
            disabled={savingBackupSchedule || !server.permissions?.canAdmin}
            className="flex items-center gap-1.5 rounded-lg bg-[#0078D4] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#0065B3] disabled:opacity-50"
          >
            {savingBackupSchedule ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save Backup Schedule
          </button>
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
            Export / Clone
          </p>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-[#666]">
            Export a reusable JSON template or open the create flow with this server pre-filled.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportServer}
              className="px-3 py-2 rounded-lg bg-[#0078D4] text-white text-xs"
            >
              Export Config
            </button>
            <button
              onClick={cloneServerFromTemplate}
              className="px-3 py-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] text-[#f2f2f2] text-xs hover:bg-[#222]"
            >
              Clone Server
            </button>
          </div>
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

      <NotesTagsEditor
        serverName={name}
        notes={server.notes ?? ""}
        tags={server.tags ?? []}
        onSaved={refreshServerDetails}
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
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "dashboard";
    return (window.localStorage.getItem(`${GAME_HUB_TAB_STORAGE_PREFIX}:${name}`) as TabId | null) ?? "dashboard";
  });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [mobileActionSheetOpen, setMobileActionSheetOpen] = useState(false);
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

  const { data: connectivity } = useQuery<ConnectivityDetails>({
    queryKey: ["game-hub", "connectivity", name],
    queryFn: () => fetchJson(`/api/game-hub/servers/${name}/connectivity`),
    refetchInterval: 30000,
  });

  async function doAction(action: string, successMessage?: string) {
    setActionLoading(action);
    try {
      await fetchJson(`/api/game-hub/servers/${name}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      toast.success(successMessage ?? `${action} successful`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
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
  const primaryTag = server?.tags?.[0] ?? server?.groups?.[0] ?? null;

  function copyConnectionInfo() {
    if (!connectionInfo) return;
    navigator.clipboard.writeText(connectionInfo);
    toast.success("Connection info copied");
  }

  async function toggleMaintenanceMode() {
    if (!server) return;
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
      queryClient.invalidateQueries({ queryKey: ["game-hub", "server", name] });
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function cloneCurrentServer() {
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
      queryClient.invalidateQueries({ queryKey: ["game-hub", "servers"] });
    } catch (error) {
      toast.error(String(error));
    }
  }

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

  const tabs = useMemo<Array<{ id: TabId; label: string; icon: React.ElementType }>>(() => {
    const next: Array<{ id: TabId; label: string; icon: React.ElementType }> = [
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    ];

    if (server?.permissions?.canOpenConsole) {
      next.push({ id: "console", label: "Console", icon: Terminal });
    }
    if (status !== "stopped" && server?.permissions?.canPlayers) {
      next.push({ id: "players", label: "Players", icon: Users });
    }
    if (server?.permissions?.canWriteFiles) {
      next.push({ id: "files", label: "Files", icon: FolderOpen });
    }

    next.push({ id: "activity", label: "Activity", icon: Activity });

    if (server?.permissions?.canAdmin) {
      next.push({ id: "settings", label: "Settings", icon: Settings });
    }

    return next;
  }, [server?.permissions?.canAdmin, server?.permissions?.canOpenConsole, server?.permissions?.canPlayers, server?.permissions?.canWriteFiles, status]);

  const resolvedActiveTab = tabs.some((tab) => tab.id === activeTab)
    ? activeTab
    : (tabs[0]?.id ?? "dashboard");
  const activeTabIndex = tabs.findIndex((tab) => tab.id === resolvedActiveTab);
  const activeTabConfig = tabs[activeTabIndex] ?? tabs[0];

  const cycleTab = (direction: -1 | 1) => {
    if (!tabs.length) return;
    const nextIndex = (activeTabIndex + direction + tabs.length) % tabs.length;
    setActiveTab(tabs[nextIndex]?.id ?? resolvedActiveTab);
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(`${GAME_HUB_TAB_STORAGE_PREFIX}:${name}`, resolvedActiveTab);
  }, [name, resolvedActiveTab]);

  return (
    <div className="space-y-0 overflow-x-hidden pb-2">
      <div className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-4 border-b border-[#1e1e1e] bg-[#0e0e0e]/95 px-4 pb-0 pt-0 backdrop-blur-sm sm:-mx-4 sm:px-4 md:-mx-6 md:px-6">
        <div className="hidden sm:flex items-center gap-1 px-1 pt-2 text-[10px] text-[#666] overflow-x-auto scrollbar-none whitespace-nowrap">
          <Link href="/game-hub" className="hover:text-white">
            Game Hub
          </Link>
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="text-[#9e9e9e] truncate">{name}</span>
        </div>
        <div className="flex flex-wrap items-start gap-2 py-2 sm:py-3">
          <Link
            href="/game-hub"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-[#555] transition-colors hover:bg-[#1e1e1e] hover:text-[#9e9e9e]"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <span className="text-2xl flex-shrink-0">{server?.icon ?? "🎮"}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-[#f2f2f2] sm:flex-none sm:text-xl">
                {name}
              </h1>
              {primaryTag && (
                <span className="shrink-0 rounded-full bg-[#222] px-2 py-0.5 text-xs text-[#888]">
                  {primaryTag}
                </span>
              )}
              {server?.podStartTime && (
                <span className="shrink-0 text-xs text-[#666]">
                  ↺ {timeAgo(server.podStartTime)}
                </span>
              )}
              <div className="flex shrink-0 items-center gap-1.5">
                <span
                  className={cn(
                    "w-2 h-2 rounded-full flex-shrink-0",
                    statusDot,
                  )}
                />
                <span className={cn("text-[11px] capitalize", statusText)}>
                  {status}
                </span>
                {typeof connectivity?.external.latencyMs === "number" && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-[#666]" title={`Connection quality ${connectivity.external.latencyMs}ms`}>
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        connectivity.external.latencyMs < 100
                          ? "bg-emerald-400"
                          : connectivity.external.latencyMs < 250
                            ? "bg-amber-400"
                            : "bg-red-400",
                      )}
                    />
                    {connectivity.external.latencyMs}ms
                  </span>
                )}
              </div>
            </div>
            <p className="mt-0.5 text-[10px] text-[#555] line-clamp-2 sm:line-clamp-1">
              {server?.description ||
                `${server?.gameType?.replace(/-/g, " ") ?? "Game"} Server`}
            </p>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
              {server?.imageVersion && (
                <span className="rounded-full border border-[#2a2a2a] bg-[#111] px-2 py-0.5 text-[#9e9e9e]">
                  Version {server.imageVersion}
                </span>
              )}
              {server?.imagePinned ? (
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200">
                  ✓ Pinned to {server.imageVersion}
                </span>
              ) : server ? (
                <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-yellow-200">
                  Using latest tag
                </span>
              ) : null}
              {server?.permissions?.canAdmin && server?.imageVersion && (
                <button
                  onClick={() =>
                    void doAction(
                      server.imagePinned ? "unpin-image-version" : "pin-image-version",
                      server.imagePinned
                        ? "Using latest image tag"
                        : `Pinned to ${server.imageVersion}`,
                    )
                  }
                  disabled={
                    actionLoading === "pin-image-version" ||
                    actionLoading === "unpin-image-version"
                  }
                  className="hidden min-h-[44px] rounded-full border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-1 text-[#d4d4d4] transition-colors hover:bg-[#222] disabled:opacity-50 sm:inline-flex"
                >
                  {actionLoading === "pin-image-version" || actionLoading === "unpin-image-version"
                    ? "Saving…"
                    : server.imagePinned
                      ? "Unpin (use latest)"
                      : "Pin to current version"}
                </button>
              )}
              {(server?.groups ?? [])
                .filter((group) => group !== primaryTag)
                .map((group) => (
                  <span
                    key={group}
                    className="rounded-full border border-[#0078D4]/20 bg-[#0078D4]/10 px-2 py-0.5 text-[#7cc2ff]"
                  >
                    {group}
                  </span>
                ))}
            </div>
            {server?.dnsHostname && (
              <p className="mt-1 break-all text-[10px] font-mono text-emerald-300 sm:break-normal">
                DNS {server.dnsHostname}:{server.port}
              </p>
            )}
            {connectivity && (
              <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    connectivity.internal.ready
                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                      : "border-red-500/20 bg-red-500/10 text-red-300",
                  )}
                >
                  Internal {connectivity.internal.ready ? "ready" : "unavailable"}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5",
                    connectivity.external.open
                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                      : "border-yellow-500/20 bg-yellow-500/10 text-yellow-200",
                  )}
                >
                  External {connectivity.external.open ? "open" : "blocked"}
                  {typeof connectivity.external.latencyMs === "number"
                    ? ` · ${connectivity.external.latencyMs}ms`
                    : ""}
                </span>
              </div>
            )}
            {status === "stopped" && (
              <p className="mt-1 text-[10px] text-amber-300">
                Server is stopped. Use Start to bring it online.
              </p>
            )}
          </div>
          {server && (
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              {connectionInfo && (
                <button
                  onClick={copyConnectionInfo}
                  title={connectionInfo}
                  className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-xl bg-[#1a1a1a] px-3 py-2 text-xs text-[#888] transition-colors hover:bg-[#222] sm:w-auto sm:max-w-[180px] sm:flex-none"
                >
                  <span className="truncate">{connectionInfo}</span>
                </button>
              )}
              <div className="flex items-center gap-2">
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => void toggleMaintenanceMode()}
                    title={
                      server.maintenanceMode
                        ? "Exit Maintenance"
                        : "Enter Maintenance"
                    }
                    className={cn(
                      "hidden sm:flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition-all",
                      server.maintenanceMode
                        ? "border-yellow-400/40 bg-yellow-500/20 text-yellow-100 shadow-[0_0_18px_rgba(250,204,21,0.22)]"
                        : "border-[#2a2a2a] bg-[#1a1a1a] text-[#888] hover:border-yellow-500/30 hover:bg-yellow-500/10 hover:text-yellow-200",
                    )}
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    <span className="hidden min-[420px]:inline">Maintenance</span>
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => void cloneCurrentServer()}
                    className="hidden min-h-[44px] rounded-xl bg-[#1a1a1a] px-3 py-2 text-xs text-[#888] transition-colors hover:bg-[#222] lg:flex"
                  >
                    Clone
                  </button>
                ) : null}
                {status === "stopped" ? (
                  server.permissions?.canStart ? (
                    <button
                      onClick={() => void doAction("start")}
                      disabled={!!actionLoading}
                      className="flex min-h-[44px] items-center gap-1.5 rounded-xl border border-green-500/30 bg-green-500/20 px-3 py-2 text-xs font-medium text-green-300 disabled:opacity-50 touch-manipulation hover:bg-green-500/30"
                    >
                      {actionLoading === "start" ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Play className="w-3.5 h-3.5" />
                      )}
                      Start
                    </button>
                  ) : null
                ) : (
                  <>
                    {server.permissions?.canAdmin ? (
                      <button
                        onClick={() => void doAction("restart")}
                        disabled={!!actionLoading}
                        title="Quick restart"
                        className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#1a1a1a] px-2.5 py-2 text-xs text-[#888] transition-colors disabled:opacity-50 touch-manipulation hover:bg-[#222] hover:text-[#bbb]"
                      >
                        {actionLoading === "restart" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="w-3.5 h-3.5" />
                        )}
                        <span className="hidden min-[380px]:inline">Restart</span>
                      </button>
                    ) : null}
                    {server.permissions?.canStop ? (
                      <button
                        onClick={() => void doAction("stop")}
                        disabled={!!actionLoading}
                        title="Stop"
                        className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-[#1a1a1a] px-2.5 py-2 text-xs text-[#888] transition-colors disabled:opacity-50 touch-manipulation hover:bg-red-500/15 hover:text-red-300"
                      >
                        {actionLoading === "stop" ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Square className="w-3.5 h-3.5" />
                        )}
                        <span className="hidden min-[380px]:inline">Stop</span>
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {(server.permissions?.canAdmin || server.permissions?.canStart || server.permissions?.canStop) ? (
                <button
                  onClick={() => setMobileActionSheetOpen(true)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#1a1a1a] text-[#888] transition-colors hover:bg-[#222] sm:hidden"
                  aria-label="More server actions"
                  title="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          )}
        </div>

        {activeTabConfig ? (
          <div className="flex items-center gap-2 pb-2 sm:hidden">
            <button
              onClick={() => cycleTab(-1)}
              disabled={tabs.length < 2}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#151515] text-[#888] transition-colors hover:bg-[#1d1d1d] disabled:opacity-40"
              aria-label="Previous tab"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl border border-[#0078D4]/20 bg-[#0078D4]/10 px-3 text-sm font-medium text-[#4db3ff]">
              <activeTabConfig.icon className="h-4 w-4" />
              <span>{activeTabConfig.label}</span>
            </div>
            <button
              onClick={() => cycleTab(1)}
              disabled={tabs.length < 2}
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-[#2a2a2a] bg-[#151515] text-[#888] transition-colors hover:bg-[#1d1d1d] disabled:opacity-40"
              aria-label="Next tab"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        <div className="hidden -mx-1 gap-1 overflow-x-auto px-1 pb-1 scrollbar-none touch-pan-x sm:flex">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "-mb-px flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-t-xl border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors touch-manipulation sm:px-4 sm:py-2.5",
                resolvedActiveTab === id
                  ? "border-[#0078D4] bg-[#0078D4]/10 text-[#4db3ff] shadow-[inset_0_1px_0_rgba(77,179,255,0.2)]"
                  : "border-transparent text-[#555] hover:bg-white/5 hover:text-[#888]",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-3 sm:pt-4">
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
              key={resolvedActiveTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              {resolvedActiveTab === "dashboard" && (
                <div className="space-y-4">
                  <DashboardTab server={server} name={name} connectivity={connectivity} />
                  {server.gameType.toLowerCase().includes("minecraft") ? (
                    <div className="grid gap-4 xl:grid-cols-2">
                      <WorldInfo serverName={name} mountPath={mountPath} gameType={server.gameType} />
                      <RconPanel
                        serverName={name}
                        gameType={server.gameType}
                        permissions={server.permissions}
                      />
                    </div>
                  ) : null}
                </div>
              )}
              {resolvedActiveTab === "console" && (
                <ConsoleTab name={name} status={status} server={server} />
              )}
              {resolvedActiveTab === "players" && (
                <PlayersTab name={name} server={server} />
              )}
              {resolvedActiveTab === "files" && (
                <FilesTab name={name} status={status} mountPath={mountPath} />
              )}
              {resolvedActiveTab === "activity" && <ActivityTab name={name} />}
              {resolvedActiveTab === "settings" && (
                <SettingsTab name={name} server={server} />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      <AnimatePresence>
        {mobileActionSheetOpen && server ? (
          <>
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileActionSheetOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 sm:hidden"
              aria-label="Close server actions"
            />
            <motion.div
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 35, stiffness: 320 }}
              className="fixed inset-x-0 bottom-0 z-50 rounded-t-[28px] border border-[#2a2a2a] bg-[#111] p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl sm:hidden"
            >
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-[#2a2a2a]" />
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#f2f2f2]">Server actions</p>
                  <p className="text-xs text-[#666]">Quick controls for {name}</p>
                </div>
                <button
                  onClick={() => setMobileActionSheetOpen(false)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#1a1a1a] text-[#888]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid gap-2">
                {server.permissions?.canAdmin && server.imageVersion ? (
                  <button
                    onClick={() => {
                      setMobileActionSheetOpen(false);
                      void doAction(
                        server.imagePinned ? "unpin-image-version" : "pin-image-version",
                        server.imagePinned
                          ? "Using latest image tag"
                          : `Pinned to ${server.imageVersion}`,
                      );
                    }}
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-[#2a2a2a] bg-[#161616] px-4 text-sm text-[#d4d4d4]"
                  >
                    <span>{server.imagePinned ? "Use latest image" : "Pin current image"}</span>
                    <Package className="h-4 w-4 text-[#888]" />
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => {
                      setMobileActionSheetOpen(false);
                      void toggleMaintenanceMode();
                    }}
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-[#2a2a2a] bg-[#161616] px-4 text-sm text-[#d4d4d4]"
                  >
                    <span>{server.maintenanceMode ? "Disable maintenance" : "Enable maintenance"}</span>
                    <Wrench className="h-4 w-4 text-[#888]" />
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => {
                      setMobileActionSheetOpen(false);
                      void cloneCurrentServer();
                    }}
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-[#2a2a2a] bg-[#161616] px-4 text-sm text-[#d4d4d4]"
                  >
                    <span>Clone server</span>
                    <Copy className="h-4 w-4 text-[#888]" />
                  </button>
                ) : null}
                {status === "stopped" ? (
                  server.permissions?.canStart ? (
                    <button
                      onClick={() => {
                        setMobileActionSheetOpen(false);
                        void doAction("start");
                      }}
                      className="flex min-h-[52px] items-center justify-between rounded-2xl border border-green-500/30 bg-green-500/20 px-4 text-sm font-medium text-green-200"
                    >
                      <span>Start server</span>
                      <Play className="h-4 w-4" />
                    </button>
                  ) : null
                ) : (
                  <>
                    {server.permissions?.canAdmin ? (
                      <button
                        onClick={() => {
                          setMobileActionSheetOpen(false);
                          void doAction("restart");
                        }}
                        className="flex min-h-[52px] items-center justify-between rounded-2xl border border-[#2a2a2a] bg-[#161616] px-4 text-sm text-[#d4d4d4]"
                      >
                        <span>Restart server</span>
                        <RotateCcw className="h-4 w-4 text-[#888]" />
                      </button>
                    ) : null}
                    {server.permissions?.canStop ? (
                      <button
                        onClick={() => {
                          setMobileActionSheetOpen(false);
                          void doAction("stop");
                        }}
                        className="flex min-h-[52px] items-center justify-between rounded-2xl border border-red-500/30 bg-red-500/10 px-4 text-sm font-medium text-red-200"
                      >
                        <span>Stop server</span>
                        <Square className="h-4 w-4" />
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>
      <MiniOverviewDrawer currentServerName={name} />
    </div>
  );
}
