"use client";

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ChangeEvent,
  type ElementType,
  type ReactNode,
} from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { useSession } from "next-auth/react";
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
  OctagonX,
} from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { describeEggVariableRules, getEggForGameType, validateEggVariable } from "@/lib/game-eggs";
import { toast } from "@/lib/notify";
import Link from "next/link";
// Note: previously used Monaco editor; replaced with styled <textarea> + <pre>
// for instant load + no CDN dependency on Monaco worker scripts.
import { ActivityTab as ActivityTabFeature } from "@/components/game-hub/server-detail/activity-tab";
import { BanList } from "@/components/game-hub/server-detail/ban-list";
import { ConfigEditor } from "@/components/game-hub/server-detail/config-editor";
import { ConsoleTab } from "@/components/game-hub/server-detail/console-tab";
import { DashboardTab as DashboardTabFeature } from "@/components/game-hub/server-detail/dashboard-tab";
import { EnvTableEditor } from "@/components/game-hub/server-detail/env-table-editor";
import { MiniOverviewDrawer } from "@/components/game-hub/server-detail/mini-overview-drawer";
import { NotesTagsEditor } from "@/components/game-hub/server-detail/notes-tags-editor";
import { KeyboardShortcutsDialog } from "@/components/game-hub/server-detail/keyboard-shortcuts";
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
import { DeleteServerModal } from "@/components/game-hub/server-detail/delete-server-modal";

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

type SnapshotListResponse = {
  snapshots: Array<{
    metadata?: {
      name?: string;
      creationTimestamp?: string;
      annotations?: Record<string, string>;
    };
    status?: { readyToUse?: boolean };
  }>;
};

const EMPTY_SNAPSHOT_RESPONSE: SnapshotListResponse = { snapshots: [] };
const EMPTY_STRING_ARRAY: string[] = [];
const ACCENT_ANNOTATION_KEY = "game-hub/accent-color";
const ACCENT_COLOR_OPTIONS = ["#0078D4", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#f87171"];

function buildFallbackConnectivity(message: string): ConnectivityDetails {
  return {
    status: "unknown",
    message,
    internal: { ready: false, clusterIP: null, port: null, message },
    external: {
      status: "unknown",
      open: null,
      host: null,
      port: null,
      protocol: null,
      latencyMs: null,
      message,
    },
    ports: [],
  };
}

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
    <div className={cn("rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3", tone.bg)}>
      <div className="flex items-center gap-3">
        <div
          className="relative flex h-14 w-14 items-center justify-center rounded-full"
          style={{
            background: `conic-gradient(${tone.color} 0 ${percent}%, #1f1f1f ${percent}% 100%)`,
          }}
        >
          <div className="absolute inset-[5px] rounded-full bg-white dark:bg-[#111]" />
          <span className={cn("relative text-xs font-semibold", tone.text)}>
            {value}
            {suffix}
          </span>
        </div>
        <div>
          <p className="text-xs font-medium text-gray-900 dark:text-[#f2f2f2]">{label}</p>
          <p className="text-[10px] text-gray-400 dark:text-[#666]">Preview trigger ring</p>
        </div>
      </div>
    </div>
  );
}

function isSensitiveEnvName(name: string) {
  return /password|secret|key|token|api_key|auth|credential|private/i.test(name);
}

function normalizeAccentColor(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : ACCENT_COLOR_OPTIONS[0]!;
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
  const parts: ReactNode[] = [];
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
      <div className="flex flex-col items-center justify-center h-40 gap-3 text-gray-400 dark:text-[#555]">
        <FolderOpen className="w-8 h-8" />
        <p className="text-sm">Start the server to browse files</p>
      </div>
    );
  }

  const fileTree = (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-2">
        <div className="flex items-center gap-1 px-1 pb-2">
          <button
            onClick={goUp}
            disabled={pathHistory.length <= 1}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#1e1e1e] disabled:opacity-30 transition-colors flex-shrink-0"
          >
            <ArrowUp className="w-3.5 h-3.5 text-gray-400 dark:text-[#666]" />
          </button>
          <div className="flex-1 min-w-0 overflow-x-auto scrollbar-none">
            <div className="flex items-center gap-1.5 w-max min-w-full text-[10px] font-mono text-gray-500 dark:text-[#777]">
              <button
                onClick={() => {
                  setCurrentPath(mountPath);
                  setPathHistory([mountPath]);
                  setDiffOpen(false);
                  setSelectedFile(null);
                  setFileContent(null);
                  originalContentRef.current = null;
                }}
                className="rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-[#1e1e1e]"
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
                      className="rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-[#1e1e1e]"
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
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-[#1e1e1e] transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-3 h-3 text-gray-400 dark:text-[#555]" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 dark:text-[#555]" />
            <input
              value={fileSearch}
              onChange={(event) => setFileSearch(event.target.value)}
              placeholder="Search files…"
              className="w-full rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] py-1.5 pl-8 pr-3 text-xs text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
          </div>
          <select
            value={sortKey}
            onChange={(event) =>
              setSortKey(event.target.value as "name" | "size" | "modified")
            }
            className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-2 py-1.5 text-[10px] text-[#bbb] focus:outline-none"
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
              className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2 py-1 text-[10px] text-gray-500 dark:text-[#9e9e9e] hover:text-gray-900 dark:hover:text-white"
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 className="w-4 h-4 animate-spin text-gray-400 dark:text-[#555]" />
          </div>
        ) : sortedFiles.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-[#555] text-center py-6">
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
                    ? "bg-[rgba(0,120,212,0.2)] text-gray-900 dark:text-white"
                    : "hover:bg-gray-100 dark:hover:bg-[#1a1a1a] text-gray-500 dark:text-[#9e9e9e]",
                )}
              >
                {entry.type === "directory" ? (
                  <Folder className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                ) : (
                  <File className="w-3.5 h-3.5 text-gray-400 dark:text-[#444] flex-shrink-0" />
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
                          "text-gray-900 dark:text-white",
                      )}
                    >
                      {entry.name}
                    </span>
                    <span className="shrink-0 rounded border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-1.5 py-0.5 text-[10px] font-mono text-[#8fb8ff]">
                      {entry.permissions || "---------"}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-400 dark:text-[#555]">
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
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 dark:text-[#444] hover:text-green-300 transition-all"
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
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 dark:text-[#444] hover:text-red-400 transition-all"
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
              <span className="text-xs text-gray-400 dark:text-[#555] font-mono truncate block">
                {selectedFile.path}
              </span>
              <span className="text-[10px] text-gray-400 dark:text-[#444]">
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
              className="p-1.5 text-gray-400 dark:text-[#444] hover:text-gray-700 dark:hover:text-[#888] flex-shrink-0"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
            {isArchiveFile && (
              <button
                onClick={() => void extractArchive(selectedFile)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-[#1a1a1a] hover:bg-gray-100 dark:hover:bg-[#252525] text-gray-700 dark:text-[#d4d4d4] rounded-lg text-xs font-medium flex-shrink-0"
              >
                <Package className="w-3 h-3" /> Extract
              </button>
            )}
            {!isImageFile && isDirty && (
              <button
                onClick={() => setDiffOpen(true)}
                disabled={saving || loadingContent}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-[#1a1a1a] hover:bg-gray-100 dark:hover:bg-[#252525] disabled:opacity-50 text-gray-700 dark:text-[#d4d4d4] rounded-lg text-xs font-medium flex-shrink-0"
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
            className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] overflow-hidden min-w-0"
            style={{ height: "60vh", minHeight: "320px" }}
          >
            {loadingContent ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400 dark:text-[#555]" />
              </div>
            ) : fileTooLarge ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 bg-white dark:bg-[#0a0a0a] p-4">
                <FileText className="w-10 h-10 text-gray-400 dark:text-[#444]" />
                <div className="text-center">
                  <p className="text-sm font-medium text-gray-700 dark:text-[#d4d4d4] mb-1">File too large to edit in browser</p>
                  <p className="text-xs text-gray-400 dark:text-[#555]">{fileTooLarge.size > 0 ? `${(fileTooLarge.size / 1024 / 1024).toFixed(1)} MB` : "Size unknown"} — max 50 MB for inline editing</p>
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
              <div className="flex h-full items-center justify-center bg-white dark:bg-[#0a0a0a] p-4">
                <img
                  src={`/api/game-hub/servers/${name}/files/content?path=${encodeURIComponent(selectedFile.path)}&download=1`}
                  alt={selectedFile.name}
                  className="max-h-full max-w-full rounded border border-gray-200 dark:border-[#2a2a2a] object-contain"
                />
              </div>
            ) : (
              <textarea
                value={fileContent ?? ""}
                onChange={(e) => setFileContent(e.target.value)}
                spellCheck={false}
                className="w-full h-full bg-gray-50 dark:bg-[#1e1e1e] text-gray-700 dark:text-[#d4d4d4] font-mono text-[13px] leading-[1.5] p-3 resize-none focus:outline-none border-0"
                style={{ tabSize: 2 }}
                placeholder="Empty file"
              />
            )}
          </div>
        </>
      ) : (
        <div
          className="flex flex-col items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] gap-3"
          style={{ height: "55vh", minHeight: "200px" }}
        >
          <FolderOpen className="w-10 h-10 text-[#2a2a2a]" />
          <p className="text-sm text-gray-400 dark:text-[#555]">Select a file to edit</p>
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
              className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="border-b border-gray-200 dark:border-[#1e1e1e] px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.24em] text-gray-400 dark:text-[#666]">
                      Unified diff preview
                    </p>
                    <h3 className="mt-1 text-base font-semibold text-gray-900 dark:text-[#f2f2f2]">
                      {selectedFile.name}
                    </h3>
                    <p className="mt-1 text-xs text-gray-500 dark:text-[#777]">
                      {changedDiffLines} changed line{changedDiffLines === 1 ? "" : "s"} • review before saving
                    </p>
                  </div>
                  <button
                    onClick={() => setDiffOpen(false)}
                    className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] p-2 text-gray-400 dark:text-[#666] transition-colors hover:bg-gray-100 dark:hover:bg-[#161616] hover:text-[#d4d4d4]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="border-b border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#101010] px-5 py-2 font-mono text-[11px] text-gray-400 dark:text-[#666]">
                <div>--- original</div>
                <div>+++ current</div>
              </div>
              <div className="max-h-[65vh] overflow-auto bg-white dark:bg-[#0a0a0a] p-3 font-mono text-xs leading-6">
                {diffLines.length === 0 ? (
                  <div className="rounded-lg border border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#111] px-4 py-6 text-center text-gray-400 dark:text-[#666]">
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
                      <span className="mr-2 inline-block w-3 text-center text-gray-400 dark:text-[#666]">
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
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 dark:border-[#1e1e1e] bg-white dark:bg-[#101010] px-5 py-4">
                <button
                  onClick={() => setDiffOpen(false)}
                  className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] px-4 py-2 text-sm text-gray-500 dark:text-[#999] transition-colors hover:bg-gray-100 dark:hover:bg-[#161616] hover:text-gray-900 dark:hover:text-[#f2f2f2]"
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
        <div className="flex gap-1 p-1 bg-white dark:bg-[#111] rounded-lg border border-gray-200 dark:border-[#2a2a2a]">
          {(["files", "editor"] as const).map((pane) => (
            <button
              key={pane}
              onClick={() => setMobilePane(pane)}
              className={cn(
                "flex-1 py-2.5 rounded text-xs font-medium transition-colors flex items-center justify-center gap-1.5",
                mobilePane === pane ? "bg-[#0078D4] text-white" : "text-gray-400 dark:text-[#666]",
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
  return "border-gray-200 dark:border-[#333] bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888]";
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
    <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
        <div className="flex items-start gap-2">
          <Shield className="w-3.5 h-3.5 text-gray-400 dark:text-[#555] mt-0.5" />
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
              Access Control
            </p>
            <p className="text-[11px] text-gray-400 dark:text-[#555] mt-1">
              Inherited access is read-only here. Server-specific assignments
              are stored in users.yaml.
            </p>
          </div>
        </div>
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#555] font-mono">
          {scope}
        </span>
      </div>

      <div className="p-4 space-y-4">
        {!canEdit && (
          <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-3 py-2 text-xs text-gray-500 dark:text-[#777]">
            Read-only. Only Game Hub admins can change server assignments.
          </div>
        )}

        {accessQuery.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-[#555]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading access assignments…
          </div>
        ) : accessQuery.error ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
            Failed to load access control details.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] overflow-hidden">
              <button
                type="button"
                onClick={() => setShowInherited((prev) => !prev)}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left"
              >
                <div>
                  <p className="text-sm text-gray-900 dark:text-[#f2f2f2]">Inherited access</p>
                  <p className="text-xs text-gray-400 dark:text-[#555] mt-1">
                    Platform-wide and Game Hub-wide roles that also apply to
                    this server.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-gray-400 dark:text-[#666]">
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-gray-200 dark:border-[#2a2a2a]">
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
                    className="border-t border-gray-200 dark:border-[#1e1e1e] p-3 space-y-2"
                  >
                    {inheritedAssignments.length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-[#555]">
                        No inherited assignments found for this server.
                      </p>
                    ) : (
                      inheritedAssignments.map((assignment) => (
                        <div
                          key={`${assignment.user}:${assignment.role}:${assignment.scope}`}
                          className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm text-gray-900 dark:text-[#f2f2f2] truncate">
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
                            <p className="text-[10px] text-gray-400 dark:text-[#555] font-mono mt-1">
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

            <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] overflow-hidden">
              <div className="flex items-center justify-between gap-3 px-3 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
                <div>
                  <p className="text-sm text-gray-900 dark:text-[#f2f2f2]">
                    Server-specific access
                  </p>
                  <p className="text-xs text-gray-400 dark:text-[#555] mt-1">
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
                          <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
                            Username
                          </label>
                          <select
                            value={addUsername}
                            onChange={(event) =>
                              setAddUsername(event.target.value)
                            }
                            className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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
                          <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
                            Role
                          </label>
                          <select
                            value={addRole}
                            onChange={(event) =>
                              setAddRole(event.target.value as ServerAccessRole)
                            }
                            className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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
                            <p className="text-[11px] text-gray-900 dark:text-[#f2f2f2] font-mono">
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
                  <p className="text-xs text-gray-400 dark:text-[#555]">
                    No server-specific assignments yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {serverAssignments.map((assignment) => {
                      const assignmentKey = `${assignment.user}:${assignment.role}`;
                      return (
                        <div
                          key={assignmentKey}
                          className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-gray-900 dark:text-[#f2f2f2] truncate">
                              {assignment.user}
                            </p>
                            <p className="text-[10px] text-gray-400 dark:text-[#555] font-mono mt-1">
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
                                className="p-1.5 rounded-lg text-gray-400 dark:text-[#555] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
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
      className="group overflow-hidden rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111]"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{title}</p>
          {description ? <p className="text-xs text-gray-500 dark:text-[#888]">{description}</p> : null}
        </div>
        <ChevronDown className="h-4 w-4 text-gray-400 dark:text-[#555] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-gray-200 dark:border-[#1e1e1e] p-4">{children}</div>
    </details>
  );
}

function SettingsTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const envImportRef = useRef<HTMLInputElement>(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
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
  const autoRestart = server.restartPolicy === "Always";
  const [notes, setNotes] = useState(server.notes ?? "");
  const [savingNotes, setSavingNotes] = useState(false);
  const [memLimit, setMemLimit] = useState(parseMemoryMi(server.memory));
  const [cpuLimit, setCpuLimit] = useState(parseCpuMillicores(server.cpu));
  const [savingResources, setSavingResources] = useState(false);
  const [editingEnv, setEditingEnv] = useState(false);
  const [envStr, setEnvStr] = useState(stringifyEnv(server.env));
  const [savingEnv, setSavingEnv] = useState(false);
  const [description, setDescription] = useState(server.description ?? "");
  const [icon, setIcon] = useState(server.icon ?? "🎮");
  const [accentColor, setAccentColor] = useState(normalizeAccentColor(server.annotations?.[ACCENT_ANNOTATION_KEY]));
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
    if (entry.userViewable === false) return false; // respect egg permissions
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
    data: snapshotsData = EMPTY_SNAPSHOT_RESPONSE,
    refetch: refetchSnapshots,
    isFetching: snapshotsLoading,
  } = useQuery<SnapshotListResponse>({
    queryKey: ["game-hub", "snapshots", name],
    queryFn: async () => {
      try {
        return await fetchJson<SnapshotListResponse>(
          `/api/game-hub/servers/${name}/snapshot`,
        );
      } catch (error) {
        console.error("snapshot query failed", error);
        return EMPTY_SNAPSHOT_RESPONSE;
      }
    },
    enabled: isLonghornPvc,
    retry: false,
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

  function showAutoRestartInfo() {
    toast.info("Crash restart is always enabled for deployment-backed Game Hub servers.");
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

  async function importEnvFile(event: ChangeEvent<HTMLInputElement>) {
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
          annotations: {
            ...(server.annotations ?? {}),
            [ACCENT_ANNOTATION_KEY]: accentColor,
          },
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
              const validationError = editVal ? validateEggVariable(entry, editVal) : null;
              const rulesHint = describeEggVariableRules(entry.rules);
              return (
                <div key={entry.name} className="rounded-lg border border-yellow-500/10 bg-white dark:bg-[#111] px-3 py-2 space-y-2">
                  <div className="flex flex-wrap items-start gap-2">
                    <span className="rounded border border-yellow-500/20 bg-yellow-500/10 px-2 py-0.5 font-mono text-[10px] text-yellow-100 mt-0.5">{entry.name}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900 dark:text-[#f2f2f2]">{entry.description || "Recommended setting"}</p>
                      {rulesHint && <p className="text-[10px] text-gray-400 dark:text-[#555] mt-0.5">{rulesHint}</p>}
                    </div>
                  </div>
                  <div className="flex gap-2 items-center">
                    <input
                      type={/password|secret|token|key/i.test(entry.name) ? "password" : entry.fieldType === "integer" ? "number" : "text"}
                      value={editVal}
                      onChange={(e) => setUnsetEditValues((prev) => ({ ...prev, [entry.name]: e.target.value }))}
                      placeholder={entry.defaultValue || "Enter value…"}
                      className={cn(
                        "flex-1 min-w-0 rounded-md bg-white dark:bg-[#1a1a1a] border px-2.5 py-1 text-xs text-gray-700 dark:text-[#d4d4d4] font-mono focus:outline-none placeholder-[#444]",
                        validationError ? "border-red-500/40 focus:border-red-500/40" : "border-gray-200 dark:border-[#2a2a2a] focus:border-yellow-500/40"
                      )}
                    />
                    <button
                      onClick={() => void applyUnsetEnvVar(entry, editVal)}
                      disabled={state === "loading" || !editVal || Boolean(validationError)}
                      className="inline-flex items-center gap-1 rounded-md border border-green-500/30 bg-green-500/15 px-2.5 py-1 text-[11px] text-green-200 transition-colors hover:bg-green-500/20 disabled:opacity-60 flex-shrink-0"
                    >
                      {state === "loading" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>{state === "done" ? "✓ Applied" : "✓ Apply"}</span>}
                    </button>
                  </div>
                  {validationError && <p className="text-[11px] text-red-400">{validationError}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Layers className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
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
            <p className="text-xs text-gray-500 dark:text-[#888] rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] px-3 py-2">
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
                    : "bg-transparent border-gray-200 dark:border-[#2a2a2a] text-gray-400 dark:text-[#666] hover:text-gray-700 dark:hover:text-[#888]",
                )}
              >
                {mode === "static" ? "Static (fixed)" : "Dynamic (HPA)"}
              </button>
            ))}
          </div>
          {replicaMode === "static" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-400 dark:text-[#666] flex-shrink-0">
                  Replicas
                </label>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      setStaticCount((count) => Math.max(1, count - 1))
                    }
                    disabled={isServerStopped}
                    className="flex h-11 w-11 items-center justify-center rounded bg-gray-50 dark:bg-[#1e1e1e] text-sm font-bold text-gray-500 dark:text-[#888] hover:bg-gray-100 dark:hover:bg-[#2a2a2a] disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="min-w-[72px] text-center text-sm font-mono text-gray-900 dark:text-[#f2f2f2] sm:min-w-[92px]">
                    {isServerStopped ? "0 (stopped)" : staticCount}
                  </span>
                  <button
                    onClick={() =>
                      setStaticCount((count) => Math.min(10, count + 1))
                    }
                    disabled={isServerStopped}
                    className="flex h-11 w-11 items-center justify-center rounded bg-gray-50 dark:bg-[#1e1e1e] text-sm font-bold text-gray-500 dark:text-[#888] hover:bg-gray-100 dark:hover:bg-[#2a2a2a] disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-gray-400 dark:text-[#555]">
                Use Start/Stop to control server state. Static replicas cannot
                go below 1 while running.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
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
                    className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-900 dark:text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
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
                    className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-900 dark:text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
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
                    className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-2 py-1.5 text-sm text-gray-900 dark:text-[#f2f2f2] text-center focus:outline-none focus:border-[#0078D4]"
                  />
                </div>
              </div>
              {server.hpa.currentReplicas !== null && (
                <p className="text-[10px] text-gray-400 dark:text-[#555]">
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <RotateCcw className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Auto-restart Policy
          </p>
        </div>
        <div className="p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="block truncate text-sm text-gray-900 dark:text-[#f2f2f2]">Restart on crash</p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-[#888]">
                Kubernetes Deployments keep this enabled automatically for Game Hub servers.
              </p>
            </div>
            <button
              type="button"
              onClick={showAutoRestartInfo}
              className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-[#181818] px-3 py-1 text-xs font-medium text-[#bdbdbd] transition-colors hover:border-[#3b82f6]/40 hover:text-[#dbeafe]"
            >
              {autoRestart ? "Always on" : "Managed by Kubernetes"}
            </button>
          </div>
      </div>
    </div>

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Scheduled On/Off
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="block truncate text-sm text-gray-900 dark:text-[#f2f2f2]">Enable scheduled start</p>
                  <p className="truncate text-[11px] text-gray-500 dark:text-[#888]">Scale the server back to 1 replica on the selected days.</p>
                </div>
                <button
                  onClick={() => setScheduleStartEnabled((current) => !current)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                    scheduleStartEnabled ? "bg-[#3b82f6]" : "bg-gray-100 dark:bg-[#2a2a2a]",
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
                className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] disabled:opacity-50 focus:outline-none focus:border-[#0078D4]"
              />
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="block truncate text-sm text-gray-900 dark:text-[#f2f2f2]">Enable scheduled stop</p>
                  <p className="truncate text-[11px] text-gray-500 dark:text-[#888]">Scale the server down cleanly at the chosen time.</p>
                </div>
                <button
                  onClick={() => setScheduleStopEnabled((current) => !current)}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full transition-colors",
                    scheduleStopEnabled ? "bg-[#3b82f6]" : "bg-gray-100 dark:bg-[#2a2a2a]",
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
                className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] disabled:opacity-50 focus:outline-none focus:border-[#0078D4]"
              />
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_220px]">
            <div>
              <label className="mb-2 block text-[10px] text-gray-500 dark:text-[#888]">Days of week</label>
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
                          : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] text-gray-500 dark:text-[#777] hover:text-gray-700 dark:hover:text-[#bbb]",
                      )}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="mb-2 block text-[10px] text-gray-500 dark:text-[#888]">Timezone</label>
              <input
                value={scheduleTimezone}
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="America/New_York"
                className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] font-mono focus:outline-none focus:border-[#0078D4]"
              />
              <p className="mt-1 text-[10px] text-gray-500 dark:text-[#888]">CronJobs use this IANA timezone.</p>
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <AlertTriangle className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Alert Thresholds
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid gap-3 xl:grid-cols-3">
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">CPU threshold</label>
                <span className="text-xs text-gray-900 dark:text-[#f2f2f2]">{alertCpu}%</span>
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
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                />
                <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={alertCpu}
                    onChange={(event) => setAlertCpu(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                    className="w-12 bg-transparent text-right text-sm text-gray-900 dark:text-[#f2f2f2] outline-none"
                  />
                  <span className="text-xs text-gray-400 dark:text-[#666]">%</span>
                </div>
              </div>
              <ThresholdPreview label="CPU preview" value={alertCpu} max={100} suffix="%" />
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Memory threshold</label>
                <span className="text-xs text-gray-900 dark:text-[#f2f2f2]">{alertMemory}%</span>
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
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                />
                <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={alertMemory}
                    onChange={(event) => setAlertMemory(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 100))}
                    className="w-12 bg-transparent text-right text-sm text-gray-900 dark:text-[#f2f2f2] outline-none"
                  />
                  <span className="text-xs text-gray-400 dark:text-[#666]">%</span>
                </div>
              </div>
              <ThresholdPreview label="Memory preview" value={alertMemory} max={100} suffix="%" />
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Restart threshold</label>
                <span className="text-xs text-gray-900 dark:text-[#f2f2f2]">{alertRestarts}</span>
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
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                />
                <div className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2.5 py-1.5">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={alertRestarts}
                    onChange={(event) => setAlertRestarts(clampNumber(Number.parseInt(event.target.value, 10) || 0, 0, 20))}
                    className="w-12 bg-transparent text-right text-sm text-gray-900 dark:text-[#f2f2f2] outline-none"
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
        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
            <Cpu className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
            <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
              Resource Limits
            </p>
          </div>
          <div className="p-4 space-y-4">
            <p className="text-xs text-gray-400 dark:text-[#666]">
              Current applied limits: <span className="text-gray-900 dark:text-[#f2f2f2]">{server.cpu}</span> CPU and <span className="text-gray-900 dark:text-[#f2f2f2]">{server.memory}</span> memory.
            </p>
            <div className="space-y-3">
              <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">CPU</label>
                  <span className="text-sm text-gray-900 dark:text-[#f2f2f2]">{cpuLimit}m</span>
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
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                  />
                  <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2.5 py-1.5">
                    <input
                      type="number"
                      min={100}
                      max={4000}
                      step={100}
                      value={cpuLimit}
                      onChange={(event) => setCpuLimit(clampNumber(Number.parseInt(event.target.value, 10) || 100, 100, 4000))}
                      className="w-16 bg-transparent text-right text-sm text-gray-900 dark:text-[#f2f2f2] outline-none"
                    />
                    <span className="text-xs text-gray-400 dark:text-[#666]">m</span>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Memory</label>
                  <span className="text-sm text-gray-900 dark:text-[#f2f2f2]">{memLimit} MB</span>
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
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-white dark:bg-[#1a1a1a]"
                  />
                  <div className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2.5 py-1.5">
                    <input
                      type="number"
                      min={256}
                      max={8192}
                      step={256}
                      value={memLimit}
                      onChange={(event) => setMemLimit(clampNumber(Number.parseInt(event.target.value, 10) || 256, 256, 8192))}
                      className="w-16 bg-transparent text-right text-sm text-gray-900 dark:text-[#f2f2f2] outline-none"
                    />
                    <span className="text-xs text-gray-400 dark:text-[#666]">MB</span>
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

        <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
            <Shield className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
            <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
              Config Diff vs Egg Defaults
            </p>
          </div>
          <div className="p-4">
            {envDiff.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-[#555]">
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
                    <div className="font-mono text-gray-900 dark:text-[#f2f2f2]">{entry.key}</div>
                    <div className="mt-1 text-gray-500 dark:text-[#777]">
                      Default:{" "}
                      <span className="font-mono">
                        {entry.defaultValue ?? "<unset>"}
                      </span>
                    </div>
                    <div className="text-gray-500 dark:text-[#777]">
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

        <div className="space-y-4">
          <SettingsAccordion
            title={isMinecraft ? "RCON Console" : "Console Commands"}
            description="Run remote console commands for the server."
          >
            <RconPanel serverName={name} gameType={server.gameType} permissions={server.permissions} />
          </SettingsAccordion>
          {isMinecraft ? (
            <>
              <SettingsAccordion
                title="World Info"
                description="Seed, world name, and key gameplay settings."
                defaultOpen
              >
                <WorldInfo serverName={name} mountPath={mountPath} gameType={server.gameType} />
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
            </>
          ) : null}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <FileText className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Description & Identity
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded-lg p-3 text-sm text-gray-900 dark:text-[#f2f2f2] resize-y focus:outline-none focus:border-[#0078D4]"
            />
          </div>
          <div>
            <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-2">Icon</label>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
              {ICON_OPTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => setIcon(emoji)}
                  className={cn(
                    "h-10 rounded-lg border text-lg transition-colors",
                    icon === emoji
                      ? "border-[#0078D4] bg-[#0078D4]/15"
                      : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] hover:border-[#3a3a3a]",
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-2 block text-[10px] text-gray-400 dark:text-[#666]">Accent color</label>
            <div className="flex flex-wrap gap-2">
              {ACCENT_COLOR_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setAccentColor(option)}
                  className={cn(
                    "flex h-10 min-w-[44px] items-center justify-center rounded-lg border px-3 transition-colors",
                    accentColor === option
                      ? "border-[#0078D4] bg-[#0078D4]/10"
                      : "border-gray-200 bg-white hover:border-[#3a3a3a] dark:border-[#2a2a2a] dark:bg-[#0a0a0a]",
                  )}
                  title={option}
                >
                  <Circle className="h-4 w-4 fill-current" style={{ color: option }} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">Groups</label>
            <input
              value={groupsStr}
              onChange={(event) => setGroupsStr(event.target.value)}
              placeholder="production, testing, friends"
              className="w-full bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Package className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Image & Deployment
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">Image</label>
            <div className="flex flex-wrap gap-2">
              <input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                className="flex-1 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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
              <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
                Image pull policy
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  value={imagePullPolicy}
                  onChange={(event) => setImagePullPolicy(event.target.value)}
                  className="flex-1 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="Always">Always</option>
                  <option value="IfNotPresent">IfNotPresent</option>
                  <option value="Never">Never</option>
                </select>
                <button
                  onClick={savePullPolicy}
                  className="px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4]"
                >
                  Save
                </button>
              </div>
            </div>
            <div>
              <label className="block text-[10px] text-gray-400 dark:text-[#666] mb-1">
                Deployment strategy
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  value={deploymentStrategy}
                  onChange={(event) =>
                    setDeploymentStrategy(event.target.value)
                  }
                  className="flex-1 bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="RollingUpdate">RollingUpdate</option>
                  <option value="Recreate">Recreate</option>
                </select>
                <button
                  onClick={saveStrategy}
                  className="px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={rollbackDeployment}
              className="px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4] hover:bg-gray-100 dark:hover:bg-[#222]"
            >
              Rollback
            </button>
            <button
              onClick={viewYaml}
              className="px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4] hover:bg-gray-100 dark:hover:bg-[#222]"
            >
              View Raw YAML
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Wifi className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
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
                  className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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
                  className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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
                  className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                />
                <select
                  value={port.protocol}
                  onChange={(event) =>
                    updatePort(port.id, { protocol: event.target.value })
                  }
                  className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                </select>
                <button
                  onClick={() => removePortRow(port.id)}
                  disabled={servicePorts.length <= 1}
                  className="min-h-[44px] min-w-[44px] rounded-lg border border-gray-200 dark:border-[#2a2a2a] p-2 text-gray-500 dark:text-[#777] hover:text-red-300 disabled:opacity-40"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={addPortRow}
              className="px-3 py-2 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4] flex items-center gap-1.5"
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Scheduled Action
          </p>
        </div>
        <div className="p-4 space-y-3">
          {server.scheduledAction && server.scheduledTime && (
            <p className="text-xs text-gray-500 dark:text-[#888]">
              Current schedule:{" "}
              <span className="text-gray-900 dark:text-[#f2f2f2]">{server.scheduledAction}</span> @{" "}
              {formatDateTime(server.scheduledTime)}
            </p>
          )}
          <p className="text-[11px] text-gray-400 dark:text-[#666]">
            Scheduled actions require the platform to be running so the
            controller can apply them.
          </p>
          <div className="grid md:grid-cols-[200px_1fr_auto] gap-2">
            <select
              value={scheduledAction}
              onChange={(event) => setScheduledAction(event.target.value)}
              className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            >
              <option value="none">None</option>
              <option value="stop">Stop</option>
              <option value="restart">Restart</option>
            </select>
            <input
              type="datetime-local"
              value={scheduledTime}
              onChange={(event) => setScheduledTime(event.target.value)}
              className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <HardDrive className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
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
                      : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] text-gray-500 dark:text-[#888] hover:text-gray-900 dark:hover:text-[#f2f2f2]",
                  )}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          {backupSchedulePreset === "custom" && (
            <div className="space-y-2 rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3">
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Cron expression</label>
              <input
                value={backupCronExpr}
                onChange={(event) => setBackupCronExpr(event.target.value)}
                placeholder="0 4 * * *"
                className="w-full rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-sm font-mono text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
              <p className="text-[10px] text-gray-400 dark:text-[#555]">Use a standard 5-field cron: minute hour day month weekday.</p>
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-[1fr_180px]">
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3">
              <p className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Next 3 run times</p>
              <div className="mt-2 space-y-1 text-sm text-gray-900 dark:text-[#f2f2f2]">
                {backupSchedulePreset === "disabled" ? (
                  <p className="text-xs text-gray-400 dark:text-[#666]">Backups are disabled.</p>
                ) : nextBackupRuns.length > 0 ? (
                  nextBackupRuns.map((runAt) => (
                    <div key={runAt.toISOString()} className="rounded-lg border border-[#1f1f1f] bg-white dark:bg-[#111] px-3 py-2 text-xs">
                      {runAt.toLocaleString()}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-yellow-200">Unable to calculate runs for this cron expression.</p>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0d0d0d] p-3 space-y-2">
              <label className="block text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#666]">Retention (days)</label>
              <input
                type="number"
                min={1}
                max={365}
                value={backupRetention}
                onChange={(event) => setBackupRetention(clampNumber(Number.parseInt(event.target.value, 10) || 1, 1, 365))}
                className="w-full rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
              />
              <p className="text-[10px] text-gray-400 dark:text-[#555]">Keep backups for this many days.</p>
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <HardDrive className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            PVC Snapshots
          </p>
        </div>
        <div className="p-4 space-y-3">
          {!isLonghornPvc ? (
            <p className="text-xs text-gray-400 dark:text-[#666]">
              Snapshots are available for Longhorn-backed PVCs.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500 dark:text-[#888]">
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
                  <p className="text-xs text-gray-400 dark:text-[#555]">
                    {snapshotsLoading
                      ? "Loading snapshots..."
                      : "No snapshots found."}
                  </p>
                ) : (
                  (snapshotsData?.snapshots ?? []).map((snapshot) => (
                    <div
                      key={snapshot.metadata?.name}
                      className="rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-3 py-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-gray-900 dark:text-[#f2f2f2]">
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
                      <p className="text-gray-400 dark:text-[#666] mt-1">
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Terminal className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Saved Quick Commands
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            {savedCommands.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-[#555]">No saved commands yet.</p>
            ) : (
              savedCommands.map((entry) => (
                <div
                  key={`${entry.id ?? entry.label}-${entry.command}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#0a0a0a] px-3 py-2 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-900 dark:text-[#f2f2f2]">{entry.label}</p>
                    <p className="text-xs text-gray-500 dark:text-[#777] font-mono truncate">
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
              className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
            />
            <input
              value={commandText}
              onChange={(event) => setCommandText(event.target.value)}
              placeholder="Command"
              className="bg-white dark:bg-[#0a0a0a] border border-gray-200 dark:border-[#2a2a2a] rounded px-3 py-2 text-sm text-gray-900 dark:text-[#f2f2f2] focus:outline-none focus:border-[#0078D4]"
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

      <div className="rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
          <Download className="w-3.5 h-3.5 text-gray-400 dark:text-[#555]" />
          <p className="text-xs font-medium text-gray-500 dark:text-[#888] uppercase tracking-wide">
            Export / Clone
          </p>
        </div>
        <div className="p-4 space-y-3">
          <p className="text-xs text-gray-400 dark:text-[#666]">
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
              className="px-3 py-2 rounded-lg border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-[#f2f2f2] text-xs hover:bg-gray-100 dark:hover:bg-[#222]"
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
            <p className="text-sm text-gray-900 dark:text-[#f2f2f2]">Delete this server</p>
            <p className="text-xs text-gray-400 dark:text-[#666] mt-0.5">
              Permanently removes the deployment, storage, and all data. This cannot be
              undone.
            </p>
          </div>
          <button
            onClick={() => setDeleteModalOpen(true)}
            className="flex-shrink-0 flex items-center gap-1.5 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30 rounded-lg text-sm font-medium transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      <DeleteServerModal
        open={deleteModalOpen}
        serverName={name}
        hasPvc={Boolean(server.pvc)}
        hasCronJobs={Boolean(server.scheduledRestart ?? server.scheduleStart ?? server.backupSchedule)}
        onClose={() => setDeleteModalOpen(false)}
        onDeleted={() => { window.location.href = "/game-hub"; }}
      />

      <ServerRbacPanel
        serverName={name}
        canEdit={Boolean(server.permissions?.canAdmin)}
      />

      <NotesTagsEditor
        serverName={name}
        notes={server.notes ?? ""}
        tags={server.tags ?? EMPTY_STRING_ARRAY}
        onSaved={refreshServerDetails}
      />

      <AnimatePresence>
        {yamlOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-5xl bg-white dark:bg-[#111] border border-gray-200 dark:border-[#2a2a2a] rounded-xl overflow-hidden shadow-2xl"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-[#1e1e1e]">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">
                    Deployment YAML
                  </p>
                  <p className="text-xs text-gray-400 dark:text-[#666]">
                    Read-only deployment manifest
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(yamlContent);
                      toast.success("Copied");
                    }}
                    className="px-3 py-1.5 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-[#2a2a2a] text-xs text-gray-700 dark:text-[#d4d4d4]"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => setYamlOpen(false)}
                    className="p-2 text-gray-500 dark:text-[#777] hover:text-gray-900 dark:hover:text-white"
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
                  <pre className="h-full overflow-auto bg-gray-50 dark:bg-[#1e1e1e] text-gray-700 dark:text-[#d4d4d4] font-mono text-[13px] leading-[1.5] p-3 m-0 whitespace-pre">
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
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const currentUser = session?.user?.name ?? session?.user?.email ?? "you";
  const consoleOnly = searchParams.get("consoleOnly") === "1";
  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "dashboard";
    return (window.localStorage.getItem(`${GAME_HUB_TAB_STORAGE_PREFIX}:${name}`) as TabId | null) ?? "dashboard";
  });
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [mobileActionSheetOpen, setMobileActionSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
    queryFn: async () => {
      try {
        return await fetchJson<ConnectivityDetails>(
          `/api/game-hub/servers/${name}/connectivity`,
        );
      } catch (error) {
        console.error("connectivity query failed", error);
        return buildFallbackConnectivity("connectivity unavailable");
      }
    },
    refetchInterval: 30000,
    retry: false,
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

  // Trust the API's authoritative status (it derives "stopped" from the desired
  // replica count, spec.replicas === 0) instead of re-deriving from live pod
  // counts. readyReplicas/replicas reflect the running pod, which lingers while a
  // just-stopped pod terminates — that lag made a stopped server flash back to
  // "running"/"starting", looking like an auto-restart (feedback df5a9e3b). The
  // list page already consumes server.status directly; this realigns the detail
  // page. Transitional API states (installing/crash-loop/crashed) collapse to
  // "starting" to stay within the four states the UI renders.
  const status = server?.maintenanceMode
    ? "maintenance"
    : server?.status === "running"
      ? "running"
      : !server?.status || server.status === "stopped"
        ? "stopped"
        : "starting";
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
    stopped: "text-gray-400 dark:text-[#666]",
  }[status];
  const connectionInfo =
    server?.nodeIp && server?.nodePort
      ? `${server.nodeIp}:${server.nodePort}`
      : server?.nodePort
        ? `Port ${server.nodePort}`
        : server?.port
          ? `Port ${server.port}`
          : "";
  const accentColor = normalizeAccentColor(server?.annotations?.[ACCENT_ANNOTATION_KEY]);
  const clusterDnsHost = server ? `${server.dnsHostname ?? `${name}.game-hub.svc.cluster.local`}:${server.port}` : "";
  const primaryTag = server?.tags?.[0] ?? server?.groups?.[0] ?? null;

  function copyConnectionInfo() {
    if (!connectionInfo) return;
    navigator.clipboard.writeText(connectionInfo);
    toast.success("Connection info copied");
  }

  async function restartWithReason() {
    if (!server?.permissions?.canAdmin) return;
    const reason = prompt("Restart reason", server.restartReason ?? "Applying changes");
    if (reason === null) return;
    const trimmedReason = reason.trim();
    try {
      if (trimmedReason) {
        await fetchJson(`/api/game-hub/servers/${name}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-restart-reason", reason: trimmedReason }),
        });
      }
      await doAction("restart", trimmedReason ? `Restarting — ${trimmedReason}` : "Restarting server");
    } catch (error) {
      toast.error(String(error));
    }
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

  const tabs = useMemo<Array<{ id: TabId; label: string; icon: ElementType }>>(() => {
    const next: Array<{ id: TabId; label: string; icon: ElementType }> = [
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

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      const isTyping = Boolean(target?.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select");
      if (isTyping) return;
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key >= "1" && event.key <= "5") {
        const tab = tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          setActiveTab(tab.id);
        }
        return;
      }
      const lowerKey = event.key.toLowerCase();
      if (lowerKey === "r") {
        event.preventDefault();
        void refetch();
        return;
      }
      if (lowerKey === "s" && status === "stopped" && server?.permissions?.canStart) {
        event.preventDefault();
        void doAction("start");
        return;
      }
      if (lowerKey === "x" && status !== "stopped" && server?.permissions?.canStop) {
        event.preventDefault();
        void doAction("stop", "Server stopping gracefully…");
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [doAction, refetch, server?.permissions?.canStart, server?.permissions?.canStop, status, tabs]);

  if (consoleOnly) {
    if (isLoading || !server) {
      return (
        <div className="flex h-[calc(100dvh-80px)] items-center justify-center bg-[#0a0a0a]">
          <Loader2 className="h-6 w-6 animate-spin text-[#0078D4]" />
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex h-[calc(100dvh-80px)] items-center justify-center bg-[#0a0a0a] p-6">
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-300">
            {String(error)}
          </div>
        </div>
      );
    }

    return (
      <div className="fixed inset-0 bg-[#0a0a0a] p-0">
        <ConsoleTab name={name} status={status} server={server} currentUser={currentUser} />
      </div>
    );
  }

  return (
    <div className="space-y-0 overflow-x-hidden pb-2">
      <div
        className="sticky top-[env(safe-area-inset-top,0px)] z-10 -mx-4 border-b border-gray-200 dark:border-[#1e1e1e] bg-[#0e0e0e]/95 px-4 pb-0 pt-0 backdrop-blur-sm sm:-mx-4 sm:px-4 md:-mx-6 md:px-6"
        style={server ? { backgroundImage: `linear-gradient(135deg, ${accentColor}22 0%, rgba(14,14,14,0.96) 58%)`, borderBottomColor: `${accentColor}44` } : undefined}
      >
        <div className="hidden sm:flex items-center gap-1 px-1 pt-2 text-[10px] text-gray-400 dark:text-[#666] overflow-x-auto scrollbar-none whitespace-nowrap">
          <Link href="/game-hub" className="hover:text-gray-900 dark:hover:text-white">
            Game Hub
          </Link>
          <ChevronRight className="w-3 h-3 flex-shrink-0" />
          <span className="text-gray-500 dark:text-[#9e9e9e] truncate">{name}</span>
        </div>
        <div className="flex flex-wrap items-start gap-2 py-2 sm:py-3">
          <Link
            href="/game-hub"
            className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-gray-400 dark:text-[#555] transition-colors hover:bg-gray-100 dark:hover:bg-[#1e1e1e] hover:text-gray-700 dark:hover:text-[#9e9e9e]"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <span className="text-2xl flex-shrink-0">{server?.icon ?? "🎮"}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-gray-900 dark:text-[#f2f2f2] sm:flex-none sm:text-xl">
                {name}
              </h1>
              {primaryTag && (
                <span className="shrink-0 rounded-full bg-[#222] px-2 py-0.5 text-xs text-gray-500 dark:text-[#888]">
                  {primaryTag}
                </span>
              )}
              {server?.podStartTime && (
                <span className="shrink-0 rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white/70 px-2 py-0.5 text-xs text-gray-500 backdrop-blur dark:bg-[#111]/80 dark:text-[#9e9e9e]">
                  Uptime {timeAgo(server.podStartTime)}
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
                  <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 dark:text-[#666]" title={`Connection quality ${connectivity.external.latencyMs}ms`}>
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
            <p className="mt-0.5 text-[10px] text-gray-400 dark:text-[#555] line-clamp-2 sm:line-clamp-1">
              {server?.description ||
                `${server?.gameType?.replace(/-/g, " ") ?? "Game"} Server`}
            </p>
            <div className="mt-1 flex flex-wrap gap-2 text-[10px]">
              {server?.imageVersion && (
                <span className="rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] px-2 py-0.5 text-gray-500 dark:text-[#9e9e9e]">
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
                  className="hidden min-h-[44px] rounded-full border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] px-3 py-1 text-gray-700 dark:text-[#d4d4d4] transition-colors hover:bg-gray-100 dark:hover:bg-[#222] disabled:opacity-50 sm:inline-flex"
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
            {clusterDnsHost ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(clusterDnsHost); toast.success("DNS copied"); }}
                  className="inline-flex min-h-[36px] items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[10px] font-mono text-emerald-200 transition-colors hover:bg-emerald-500/15"
                >
                  <span className="truncate max-w-[260px]">DNS {clusterDnsHost}</span>
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            ) : null}
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
                    connectivity.external.status === "open"
                      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                      : connectivity.external.status === "closed"
                        ? "border-red-500/20 bg-red-500/10 text-red-300"
                        : "border-yellow-500/20 bg-yellow-500/10 text-yellow-200",
                  )}
                  title={connectivity.external.message ?? undefined}
                >
                  External {
                    connectivity.external.status === "open"
                      ? "open"
                      : connectivity.external.status === "closed"
                        ? "blocked"
                        : connectivity.external.status
                  }
                  {typeof connectivity.external.latencyMs === "number"
                    ? ` · ${connectivity.external.latencyMs}ms`
                    : connectivity.external.message
                      ? ` · ${connectivity.external.message}`
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
                  className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-xl bg-white dark:bg-[#1a1a1a] px-3 py-2 text-xs text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#222] sm:w-auto sm:max-w-[180px] sm:flex-none"
                >
                  <span className="truncate">{connectionInfo}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShortcutsOpen(true)}
                className="hidden min-h-[44px] items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:border-[#2a2a2a] dark:bg-[#1a1a1a] dark:text-[#888] dark:hover:bg-[#222] sm:inline-flex"
                title="Keyboard shortcuts"
              >
                ?
              </button>
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
                        : "border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888] hover:border-yellow-500/30 hover:bg-yellow-500/10 hover:text-yellow-200",
                    )}
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    <span className="hidden min-[420px]:inline">Maintenance</span>
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => void cloneCurrentServer()}
                    className="hidden min-h-[44px] rounded-xl bg-white dark:bg-[#1a1a1a] px-3 py-2 text-xs text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#222] lg:flex"
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
                        onClick={() => void restartWithReason()}
                        disabled={!!actionLoading}
                        title="Quick restart"
                        className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-white dark:bg-[#1a1a1a] px-2.5 py-2 text-xs text-gray-500 dark:text-[#888] transition-colors disabled:opacity-50 touch-manipulation hover:bg-gray-100 dark:hover:bg-[#222] hover:text-gray-700 dark:hover:text-[#bbb]"
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
                      <>
                        <button
                          onClick={() => void doAction("stop", "Server stopping gracefully…")}
                          disabled={!!actionLoading}
                          title={`Stop (sends game stop command: ${server.egg?.stopCommand ?? "stop"})`}
                          className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-white dark:bg-[#1a1a1a] px-2.5 py-2 text-xs text-gray-500 dark:text-[#888] transition-colors disabled:opacity-50 touch-manipulation hover:bg-red-500/15 hover:text-red-300"
                        >
                          {actionLoading === "stop" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Square className="w-3.5 h-3.5" />
                          )}
                          <span className="hidden min-[380px]:inline">Stop</span>
                        </button>
                        <button
                          onClick={() => void doAction("force-stop", "Server force-stopped")}
                          disabled={!!actionLoading}
                          title="Force Stop — immediately kills the pod (no save)"
                          className="flex min-h-[44px] items-center gap-1.5 rounded-xl bg-white dark:bg-[#1a1a1a] px-2.5 py-2 text-xs text-gray-500 dark:text-[#888] transition-colors disabled:opacity-50 touch-manipulation hover:bg-red-600/25 hover:text-red-400"
                        >
                          {actionLoading === "force-stop" ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <OctagonX className="w-3.5 h-3.5" />
                          )}
                          <span className="hidden min-[380px]:inline">Force</span>
                        </button>
                      </>
                    ) : null}
                  </>
                )}
              </div>
              {(server.permissions?.canAdmin || server.permissions?.canStart || server.permissions?.canStop) ? (
                <button
                  onClick={() => setMobileActionSheetOpen(true)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888] transition-colors hover:bg-gray-100 dark:hover:bg-[#222] sm:hidden"
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
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-[#151515] text-gray-500 dark:text-[#888] transition-colors hover:bg-[#1d1d1d] disabled:opacity-40"
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
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-gray-200 dark:border-[#2a2a2a] bg-[#151515] text-gray-500 dark:text-[#888] transition-colors hover:bg-[#1d1d1d] disabled:opacity-40"
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
                  : "border-transparent text-gray-400 dark:text-[#555] hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-700 dark:hover:text-[#888]",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <div className="pt-3 sm:pt-4">
        {isLoading && (
          <div className="flex flex-col items-center justify-center h-48 gap-3">
            <Loader2 className="w-6 h-6 text-[#0078D4] animate-spin" />
            <p className="text-xs text-gray-400 dark:text-[#555]">Loading server details…</p>
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
                  ) : (
                    <RconPanel
                      serverName={name}
                      gameType={server.gameType}
                      permissions={server.permissions}
                    />
                  )}
                </div>
              )}
              {resolvedActiveTab === "console" && (
                <ConsoleTab name={name} status={status} server={server} currentUser={currentUser} />
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
              className="fixed inset-x-0 bottom-0 z-50 rounded-t-[28px] border border-gray-200 dark:border-[#2a2a2a] bg-white dark:bg-[#111] p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl sm:hidden"
            >
              <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-gray-100 dark:bg-[#2a2a2a]" />
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Server actions</p>
                  <p className="text-xs text-gray-400 dark:text-[#666]">Quick controls for {name}</p>
                </div>
                <button
                  onClick={() => setMobileActionSheetOpen(false)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl bg-white dark:bg-[#1a1a1a] text-gray-500 dark:text-[#888]"
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
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm text-gray-700 dark:text-[#d4d4d4]"
                  >
                    <span>{server.imagePinned ? "Use latest image" : "Pin current image"}</span>
                    <Package className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => {
                      setMobileActionSheetOpen(false);
                      void toggleMaintenanceMode();
                    }}
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm text-gray-700 dark:text-[#d4d4d4]"
                  >
                    <span>{server.maintenanceMode ? "Disable maintenance" : "Enable maintenance"}</span>
                    <Wrench className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                  </button>
                ) : null}
                {server.permissions?.canAdmin ? (
                  <button
                    onClick={() => {
                      setMobileActionSheetOpen(false);
                      void cloneCurrentServer();
                    }}
                    className="flex min-h-[48px] items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm text-gray-700 dark:text-[#d4d4d4]"
                  >
                    <span>Clone server</span>
                    <Copy className="h-4 w-4 text-gray-500 dark:text-[#888]" />
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
                          void restartWithReason();
                        }}
                        className="flex min-h-[52px] items-center justify-between rounded-2xl border border-gray-200 dark:border-[#2a2a2a] bg-gray-50 dark:bg-[#161616] px-4 text-sm text-gray-700 dark:text-[#d4d4d4]"
                      >
                        <span>Restart server</span>
                        <RotateCcw className="h-4 w-4 text-gray-500 dark:text-[#888]" />
                      </button>
                    ) : null}
                    {server.permissions?.canStop ? (
                      <>
                        <button
                          onClick={() => {
                            setMobileActionSheetOpen(false);
                            void doAction("stop", "Server stopping gracefully…");
                          }}
                          className="flex min-h-[52px] items-center justify-between rounded-2xl border border-red-500/30 bg-red-500/10 px-4 text-sm font-medium text-red-200"
                        >
                          <div className="flex flex-col items-start gap-0.5">
                            <span>Stop server</span>
                            <span className="text-[11px] font-normal text-red-300/60">Sends game command: {server.egg?.stopCommand ?? "stop"}</span>
                          </div>
                          <Square className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {
                            setMobileActionSheetOpen(false);
                            void doAction("force-stop", "Server force-stopped");
                          }}
                          className="flex min-h-[52px] items-center justify-between rounded-2xl border border-red-700/40 bg-red-700/15 px-4 text-sm font-medium text-red-300"
                        >
                          <div className="flex flex-col items-start gap-0.5">
                            <span>Force stop</span>
                            <span className="text-[11px] font-normal text-red-400/60">Kills pod immediately — no save</span>
                          </div>
                          <OctagonX className="h-4 w-4" />
                        </button>
                      </>
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
