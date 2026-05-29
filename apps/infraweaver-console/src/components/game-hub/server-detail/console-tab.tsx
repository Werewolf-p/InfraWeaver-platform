"use client";

import React from "react";
import dynamic from "next/dynamic";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Circle,
  Copy,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Search,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { MetricPoint, SavedCommand, ServerDetail } from "./types";
import { fetchJson } from "./utils";

type ConsoleHistoryDepth = "1h" | "6h" | "1d" | "3d" | "7d";
type ConsoleThemeName = "dark" | "monokai" | "nord" | "dracula" | "solarized";
type LineHeightMode = "compact" | "comfortable";
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
type ConsoleLogEntry = {
  type: string;
  line: string;
  id: number;
  timestamp?: string | null;
  user?: string;
  receivedAt: number;
};
type HighlightRule = {
  id: string;
  pattern: string;
  color: HighlightColor;
};
type HighlightColor = "yellow" | "green" | "cyan" | "magenta" | "orange" | "red" | "blue";
type AlertRule = {
  id: string;
  pattern: string;
  sound: "ping" | "beep" | "chime" | "none";
  notify: boolean;
};
type MacroStep = {
  command: string;
  delayMs: number;
};
type MacroSequence = {
  name: string;
  steps: MacroStep[];
};
type TemplateModalState = {
  template: string;
  values: Record<string, string>;
  schedule: ScheduledSpec | null;
};
type ScheduledSpec = {
  fireAt: number;
  command: string;
};
type ScheduledCommand = {
  id: string;
  command: string;
  fireAt: number;
  timerId: number;
};
type PasteGuardItem = {
  id: string;
  line: string;
  checked: boolean;
};
type RecordingLine = {
  at: number;
  type: string;
  line: string;
  timestamp?: string | null;
  user?: string;
};
type RecordingExport = {
  server: string;
  startedAt: string;
  lines: RecordingLine[];
};
type ReplayState = {
  status: "idle" | "playing" | "paused";
  data: RecordingExport | null;
  nextIndex: number;
  elapsedMs: number;
  startedAtMs: number | null;
};
type ConsolePrefs = Partial<{
  autoScroll: boolean;
  showTimestamps: boolean;
  wordWrap: boolean;
  levelFilter: "all" | "error" | "warn" | "info";
  regexMode: boolean;
  historyDepth: ConsoleHistoryDepth;
  fontSize: number;
  theme: ConsoleThemeName;
  showLineNumbers: boolean;
  lineHeight: LineHeightMode;
}>;
type XtermConsoleProps = {
  lines: ConsoleLogEntry[];
  fontSize: number;
  theme: ConsoleThemeName;
  searchQuery: string;
  regexMode: boolean;
  lineHeight: LineHeightMode;
  showTimestamps: boolean;
  autoScroll: boolean;
};

type PresencePayload = {
  viewers: Array<{ name: string; initial: string }>;
};

type MetricsResponse = MetricPoint[] | { error?: string; points?: MetricPoint[] };

const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\s*/;
const CONSOLE_PREFS_KEY = "infraweaver:console-prefs";
const CONSOLE_HISTORY_KEY = "infraweaver:console-history";
const HISTORY_DEPTH_MAX_LINES: Record<ConsoleHistoryDepth, number> = {
  "1h": 2000,
  "6h": 5000,
  "1d": 10000,
  "3d": 20000,
  "7d": 20000,
};
const HIGHLIGHT_KEY_PREFIX = "infraweaver:console-highlights";
const ALERTS_KEY_PREFIX = "infraweaver:console-alerts";
const MACROS_KEY_PREFIX = "infraweaver:console-macros";
const THEME_MAP: Record<ConsoleThemeName, { bg: string; fg: string; accent: string }> = {
  dark: { bg: "#0a0a0a", fg: "#f0f0f0", accent: "#0078D4" },
  monokai: { bg: "#272822", fg: "#f8f8f2", accent: "#a6e22e" },
  nord: { bg: "#2e3440", fg: "#d8dee9", accent: "#88c0d0" },
  dracula: { bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9" },
  solarized: { bg: "#002b36", fg: "#839496", accent: "#268bd2" },
};
const HIGHLIGHT_CLASS_MAP: Record<HighlightColor, string> = {
  yellow: "bg-yellow-400/20 text-yellow-200",
  green: "bg-green-500/15 text-green-300",
  cyan: "bg-cyan-500/15 text-cyan-300",
  magenta: "bg-fuchsia-500/15 text-fuchsia-300",
  orange: "bg-orange-500/15 text-orange-300",
  red: "bg-red-500/15 text-red-300",
  blue: "bg-blue-500/15 text-blue-300",
};

function normalizeCommandValue(entry: { command?: string; cmd?: string }) {
  return entry.command ?? entry.cmd ?? "";
}

function normalizeSavedCommands(entries: ServerDetail["savedCommands"] | undefined): RuntimeSavedCommand[] {
  return ((entries ?? []) as RuntimeSavedCommand[]).map((entry) => ({
    ...entry,
    command: normalizeCommandValue(entry),
  }));
}

function normalizeQuickCommands(
  entries: Array<{ label: string; command?: string; description?: string }> | undefined,
): Array<{ label: string; command: string; description?: string }> {
  return ((entries ?? []) as RuntimeQuickCommand[])
    .map((entry) => ({
      label: entry.label,
      command: normalizeCommandValue(entry),
      description: entry.description,
    }))
    .filter((entry) => entry.command.trim().length > 0);
}

function readConsolePrefs(): ConsolePrefs {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(CONSOLE_PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function readConsoleHistory(name: string) {
  if (typeof window === "undefined") return [] as string[];
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${CONSOLE_HISTORY_KEY}:${name}`) ?? "[]") as string[];
    return stored.filter((entry) => typeof entry === "string").slice(0, 50);
  } catch {
    return [] as string[];
  }
}

function readLocalArray<T>(key: string, fallback: T[]): T[] {
  if (typeof window === "undefined") return fallback;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return Array.isArray(value) ? (value as T[]) : fallback;
  } catch {
    return fallback;
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

function detectLogLevel(type: string, line: string) {
  const value = line.toLowerCase();
  if (type === "error" || /\b(error|fatal|panic)\b/.test(value)) return "error" as const;
  if (/\bwarn(ing)?\b/.test(value)) return "warn" as const;
  return "info" as const;
}

function renderEntryLine(entry: Pick<ConsoleLogEntry, "type" | "line" | "timestamp" | "user">, showTimestamps: boolean) {
  const baseLine = entry.type === "input" ? `❯ [${entry.user ?? "you"}] ${entry.line}` : entry.line;
  if (!showTimestamps || !entry.timestamp || entry.type === "history-marker") return baseLine;
  return `${entry.timestamp} ${baseLine}`;
}

function highlightLogMatch(text: string, query: string) {
  if (!query.trim()) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: Array<string | ReactNode> = [];
  let start = 0;
  let index = lowerText.indexOf(lowerQuery);
  while (index >= 0) {
    if (index > start) parts.push(text.slice(start, index));
    parts.push(
      <mark key={`${index}-${start}`} className="rounded-sm bg-yellow-500/30 text-yellow-200">
        {text.slice(index, index + lowerQuery.length)}
      </mark>,
    );
    start = index + lowerQuery.length;
    index = lowerText.indexOf(lowerQuery, start);
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h${remMinutes ? ` ${remMinutes}m` : ""}`;
}

function extractTemplateVars(command: string) {
  const matches = command.match(/\{\{\s*([\w.-]+)\s*\}\}/g) ?? [];
  return Array.from(new Set(matches.map((entry) => entry.replace(/[{}\s]/g, ""))));
}

function substituteTemplate(command: string, values: Record<string, string>) {
  return command.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => values[key] ?? "");
}

function matchesPattern(line: string, pattern: string) {
  const text = line.toLowerCase();
  const trimmed = pattern.trim().toLowerCase();
  return trimmed.length > 0 && text.includes(trimmed);
}

function parseScheduledCommand(input: string): ScheduledSpec | null {
  const atMatch = input.match(/^\/at\s+(\d{2}):(\d{2})\s+(.+)$/i);
  if (atMatch) {
    const hours = Number.parseInt(atMatch[1] ?? "0", 10);
    const minutes = Number.parseInt(atMatch[2] ?? "0", 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      const fireAt = new Date();
      fireAt.setHours(hours, minutes, 0, 0);
      if (fireAt.getTime() <= Date.now()) fireAt.setDate(fireAt.getDate() + 1);
      return { fireAt: fireAt.getTime(), command: atMatch[3]?.trim() ?? "" };
    }
  }

  const inMatch = input.match(/^\/in\s+(\d+)([ms])\s+(.+)$/i);
  if (inMatch) {
    const amount = Number.parseInt(inMatch[1] ?? "0", 10);
    const unit = (inMatch[2] ?? "s").toLowerCase();
    const delayMs = amount * (unit === "m" ? 60_000 : 1000);
    return { fireAt: Date.now() + delayMs, command: inMatch[3]?.trim() ?? "" };
  }

  return null;
}

function hashColor(input: string) {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 60% 45%)`;
}

function buildThemeStyle(theme: ConsoleThemeName): CSSProperties {
  const selected = THEME_MAP[theme];
  return {
    "--console-bg": selected.bg,
    "--console-fg": selected.fg,
    "--console-accent": selected.accent,
  } as CSSProperties;
}

function lineColor(type: string) {
  return (
    {
      system: "text-blue-400/80",
      "history-marker": "text-[#7c8ba1]",
      error: "text-red-400",
      input: "text-yellow-300",
      output: "text-cyan-300",
    } as Record<string, string>
  )[type] ?? "text-gray-600 dark:text-[#ccc]";
}

const XtermConsole = dynamic<XtermConsoleProps>(
  async () => {
    const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]);

    function XtermConsoleInner({
      lines,
      fontSize,
      theme,
      searchQuery,
      regexMode,
      lineHeight,
      showTimestamps,
      autoScroll,
    }: XtermConsoleProps) {
      const hostRef = useRef<HTMLDivElement>(null);
      const terminalRef = useRef<InstanceType<typeof Terminal> | null>(null);
      const fitAddonRef = useRef<InstanceType<typeof FitAddon> | null>(null);
      const searchAddonRef = useRef<InstanceType<typeof SearchAddon> | null>(null);
      const previousIdsRef = useRef<number[]>([]);

      useEffect(() => {
        if (!hostRef.current) return undefined;
        const terminal = new Terminal({
          cursorBlink: false,
          disableStdin: true,
          scrollback: 5000,
          fontSize,
          lineHeight: lineHeight === "compact" ? 1.2 : 1.5,
          theme: {
            background: THEME_MAP[theme].bg,
            foreground: THEME_MAP[theme].fg,
            cursor: THEME_MAP[theme].accent,
            selectionBackground: `${THEME_MAP[theme].accent}55`,
          },
        });
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.open(hostRef.current);
        fitAddon.fit();
        terminalRef.current = terminal;
        fitAddonRef.current = fitAddon;
        searchAddonRef.current = searchAddon;

        const observer = new ResizeObserver(() => fitAddon.fit());
        observer.observe(hostRef.current);
        return () => {
          observer.disconnect();
          terminal.dispose();
          terminalRef.current = null;
          fitAddonRef.current = null;
          searchAddonRef.current = null;
        };
      }, []);

      useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        terminal.options.fontSize = fontSize;
        terminal.options.lineHeight = lineHeight === "compact" ? 1.2 : 1.5;
        terminal.options.theme = {
          background: THEME_MAP[theme].bg,
          foreground: THEME_MAP[theme].fg,
          cursor: THEME_MAP[theme].accent,
          selectionBackground: `${THEME_MAP[theme].accent}55`,
        };
        fitAddonRef.current?.fit();
      }, [fontSize, lineHeight, theme]);

      useEffect(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        const nextIds = lines.map((entry) => entry.id);
        const previousIds = previousIdsRef.current;
        const appendOnly = previousIds.length > 0 && previousIds.every((id, index) => id === nextIds[index]);
        const source = appendOnly ? lines.slice(previousIds.length) : lines;
        if (!appendOnly) {
          terminal.reset();
          terminal.options.fontSize = fontSize;
          terminal.options.lineHeight = lineHeight === "compact" ? 1.2 : 1.5;
          terminal.options.theme = {
            background: THEME_MAP[theme].bg,
            foreground: THEME_MAP[theme].fg,
            cursor: THEME_MAP[theme].accent,
            selectionBackground: `${THEME_MAP[theme].accent}55`,
          };
        }
        const entries = appendOnly ? source : lines;
        entries.forEach((entry) => {
          if (entry.type === "history-marker") return;
          terminal.writeln(renderEntryLine(entry, showTimestamps));
        });
        previousIdsRef.current = nextIds;
        if (autoScroll) terminal.scrollToBottom();
      }, [autoScroll, fontSize, lineHeight, lines, showTimestamps, theme]);

      useEffect(() => {
        if (!searchQuery.trim()) return;
        searchAddonRef.current?.findNext(searchQuery, {
          regex: regexMode,
          caseSensitive: false,
        });
      }, [regexMode, searchQuery]);

      return <div ref={hostRef} className="h-full w-full" />;
    }

    return XtermConsoleInner;
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-gray-400 dark:text-[#666]">
        Loading terminal…
      </div>
    ),
  },
);

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-4 shadow-2xl dark:border-[#2a2a2a] dark:bg-[#111]"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function HistorySearchModal({
  open,
  history,
  onClose,
  onPick,
}: {
  open: boolean;
  history: string[];
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 10);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, open]);

  const filtered = useMemo(
    () => history.filter((entry) => entry.toLowerCase().includes(query.trim().toLowerCase())),
    [history, query],
  );

  if (!open) return null;
  return (
    <ModalShell onClose={onClose}>
      <div className="space-y-3">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Command history</p>
          <p className="text-xs text-gray-500 dark:text-[#777]">Ctrl+R search</p>
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search history…"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
        />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-500 dark:border-[#2a2a2a] dark:text-[#666]">
              No matching history
            </div>
          ) : (
            filtered.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => onPick(entry)}
                className="block w-full rounded-lg border border-gray-200 px-3 py-2 text-left text-xs font-mono text-gray-700 transition-colors hover:bg-gray-100 dark:border-[#2a2a2a] dark:text-[#ddd] dark:hover:bg-[#1a1a1a]"
              >
                {entry}
              </button>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function TemplateVarModal({
  state,
  onClose,
  onChange,
  onSend,
}: {
  state: TemplateModalState | null;
  onClose: () => void;
  onChange: (name: string, value: string) => void;
  onSend: () => void;
}) {
  if (!state) return null;
  const vars = Object.keys(state.values);
  return (
    <ModalShell onClose={onClose}>
      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Template variables</p>
          <p className="text-xs text-gray-500 dark:text-[#777]">Fill the placeholders before sending.</p>
        </div>
        <div className="space-y-3">
          {vars.map((variable) => (
            <label key={variable} className="block space-y-1">
              <span className="text-xs text-gray-500 dark:text-[#888]">{variable}</span>
              <input
                value={state.values[variable] ?? ""}
                onChange={(event) => onChange(variable, event.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#f2f2f2]"
              />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-[#888]">
            Cancel
          </button>
          <button type="button" onClick={onSend} className="rounded-lg bg-[#0078D4] px-3 py-2 text-xs font-medium text-white">
            Send
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PasteGuardModal({
  items,
  onToggle,
  onCancel,
  onSend,
}: {
  items: PasteGuardItem[] | null;
  onToggle: (id: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  if (!items) return null;
  return (
    <ModalShell onClose={onCancel}>
      <div className="space-y-4">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-[#f2f2f2]">Paste guard</p>
          <p className="text-xs text-gray-500 dark:text-[#777]">Review multi-line paste before sending.</p>
        </div>
        <div className="max-h-72 space-y-2 overflow-y-auto">
          {items.map((item) => (
            <label key={item.id} className="flex items-start gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a]">
              <input type="checkbox" checked={item.checked} onChange={() => onToggle(item.id)} className="mt-0.5" />
              <span className="font-mono text-gray-700 dark:text-[#ddd]">{item.line}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-xs text-gray-500 dark:text-[#888]">
            Cancel
          </button>
          <button type="button" onClick={onSend} className="rounded-lg bg-[#0078D4] px-3 py-2 text-xs font-medium text-white">
            Send All
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function MacroPanel({
  open,
  macros,
  draftName,
  draftSteps,
  onDraftNameChange,
  onDraftStepChange,
  onAddDraftStep,
  onRemoveDraftStep,
  onSave,
  onRun,
  onDelete,
  running,
  onCancelRunning,
}: {
  open: boolean;
  macros: MacroSequence[];
  draftName: string;
  draftSteps: MacroStep[];
  onDraftNameChange: (value: string) => void;
  onDraftStepChange: (index: number, field: keyof MacroStep, value: string) => void;
  onAddDraftStep: () => void;
  onRemoveDraftStep: (index: number) => void;
  onSave: () => void;
  onRun: (macro: MacroSequence) => void;
  onDelete: (name: string) => void;
  running: { name: string; step: number; total: number } | null;
  onCancelRunning: () => void;
}) {
  if (!open) return null;
  return (
    <div className="border-b border-gray-200 bg-white/90 px-4 py-3 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/90">
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-[#2a2a2a]">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-[#777]">Macro editor</p>
            <button type="button" onClick={onAddDraftStep} className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] dark:border-[#2a2a2a]">
              + Step
            </button>
          </div>
          <input
            value={draftName}
            onChange={(event) => onDraftNameChange(event.target.value)}
            placeholder="Macro name"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
          />
          <div className="space-y-2">
            {draftSteps.map((step, index) => (
              <div key={`${index}-${step.command}`} className="grid gap-2 rounded-lg border border-gray-200 p-2 dark:border-[#2a2a2a] sm:grid-cols-[1fr_120px_auto]">
                <input
                  value={step.command}
                  onChange={(event) => onDraftStepChange(index, "command", event.target.value)}
                  placeholder="say Hello"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-mono outline-none dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
                />
                <input
                  type="number"
                  min={0}
                  value={step.delayMs}
                  onChange={(event) => onDraftStepChange(index, "delayMs", event.target.value)}
                  placeholder="500"
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
                />
                <button type="button" onClick={() => onRemoveDraftStep(index)} className="rounded-lg px-3 py-2 text-xs text-red-400">
                  Delete
                </button>
              </div>
            ))}
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={onSave} className="rounded-lg bg-[#0078D4] px-3 py-2 text-xs font-medium text-white">
              Save macro
            </button>
          </div>
        </div>
        <div className="space-y-3 rounded-xl border border-gray-200 p-3 dark:border-[#2a2a2a]">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-[#777]">Saved macros</p>
            {running ? (
              <button type="button" onClick={onCancelRunning} className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                Cancel
              </button>
            ) : null}
          </div>
          {running ? (
            <div className="rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/10 px-3 py-2 text-xs text-[#4db3ff]">
              Running macro… {running.name} ({running.step}/{running.total})
            </div>
          ) : null}
          <div className="space-y-2">
            {macros.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-500 dark:border-[#2a2a2a] dark:text-[#666]">
                No macros saved yet
              </div>
            ) : (
              macros.map((macro) => (
                <div key={macro.name} className="rounded-lg border border-gray-200 p-3 dark:border-[#2a2a2a]">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900 dark:text-[#f2f2f2]">{macro.name}</p>
                      <p className="text-[11px] text-gray-500 dark:text-[#777]">{macro.steps.length} steps</p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => onRun(macro)} className="rounded-lg bg-[#0078D4] px-2.5 py-1 text-[11px] text-white">
                        Run
                      </button>
                      <button type="button" onClick={() => onDelete(macro.name)} className="rounded-lg px-2.5 py-1 text-[11px] text-red-400">
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1 text-[11px] text-gray-500 dark:text-[#888]">
                    {macro.steps.map((step, index) => (
                      <div key={`${macro.name}-${index}`} className="font-mono">
                        {index + 1}. {step.command} · {step.delayMs}ms
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function HighlightRulesPanel({
  open,
  rules,
  draftPattern,
  draftColor,
  onDraftPatternChange,
  onDraftColorChange,
  onAdd,
  onDelete,
}: {
  open: boolean;
  rules: HighlightRule[];
  draftPattern: string;
  draftColor: HighlightColor;
  onDraftPatternChange: (value: string) => void;
  onDraftColorChange: (value: HighlightColor) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  if (!open) return null;
  return (
    <div className="border-b border-gray-200 bg-white/90 px-4 py-3 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/90">
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#2a2a2a]">
        <div className="flex flex-wrap gap-2">
          <input
            value={draftPattern}
            onChange={(event) => onDraftPatternChange(event.target.value)}
            placeholder="Pattern"
            className="min-w-[180px] flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
          />
          <select
            value={draftColor}
            onChange={(event) => onDraftColorChange(event.target.value as HighlightColor)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
          >
            {Object.keys(HIGHLIGHT_CLASS_MAP).map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <button type="button" onClick={onAdd} className="rounded-lg bg-[#0078D4] px-3 py-2 text-xs font-medium text-white">
            Add rule
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {rules.length === 0 ? (
            <span className="text-xs text-gray-500 dark:text-[#777]">No highlight rules yet.</span>
          ) : (
            rules.map((rule) => (
              <span key={rule.id} className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs", HIGHLIGHT_CLASS_MAP[rule.color])}>
                {rule.pattern}
                <button type="button" onClick={() => onDelete(rule.id)} className="text-current/80">
                  ✕
                </button>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function AlertRulesPanel({
  open,
  rules,
  draftPattern,
  draftSound,
  draftNotify,
  permission,
  onDraftPatternChange,
  onDraftSoundChange,
  onDraftNotifyChange,
  onAdd,
  onDelete,
  onRequestPermission,
}: {
  open: boolean;
  rules: AlertRule[];
  draftPattern: string;
  draftSound: AlertRule["sound"];
  draftNotify: boolean;
  permission: NotificationPermission | "unsupported";
  onDraftPatternChange: (value: string) => void;
  onDraftSoundChange: (value: AlertRule["sound"]) => void;
  onDraftNotifyChange: (value: boolean) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onRequestPermission: () => void;
}) {
  if (!open) return null;
  return (
    <div className="border-b border-gray-200 bg-white/90 px-4 py-3 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/90">
      <div className="rounded-xl border border-gray-200 p-3 dark:border-[#2a2a2a]">
        <div className="flex flex-wrap gap-2">
          <input
            value={draftPattern}
            onChange={(event) => onDraftPatternChange(event.target.value)}
            placeholder="Alert pattern"
            className="min-w-[180px] flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
          />
          <select
            value={draftSound}
            onChange={(event) => onDraftSoundChange(event.target.value as AlertRule["sound"])}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]"
          >
            <option value="ping">ping</option>
            <option value="beep">beep</option>
            <option value="chime">chime</option>
            <option value="none">none</option>
          </select>
          <label className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a] dark:text-[#ddd]">
            <input type="checkbox" checked={draftNotify} onChange={(event) => onDraftNotifyChange(event.target.checked)} />
            Notify
          </label>
          <button type="button" onClick={onAdd} className="rounded-lg bg-[#0078D4] px-3 py-2 text-xs font-medium text-white">
            Add alert
          </button>
          {permission !== "granted" && permission !== "unsupported" ? (
            <button type="button" onClick={onRequestPermission} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a] dark:text-[#ddd]">
              Request notification permission
            </button>
          ) : null}
        </div>
        <div className="mt-3 space-y-2">
          {rules.length === 0 ? (
            <span className="text-xs text-gray-500 dark:text-[#777]">No alert rules yet.</span>
          ) : (
            rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a] dark:text-[#ddd]">
                <span className="font-mono">{rule.pattern}</span>
                <span className="text-gray-500 dark:text-[#888]">{rule.sound}{rule.notify ? " · notify" : ""}</span>
                <button type="button" onClick={() => onDelete(rule.id)} className="text-red-400">
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function PresenceIndicator({ name, currentUser }: { name: string; currentUser: string }) {
  const [viewers, setViewers] = useState<Array<{ name: string; initial: string }>>([]);
  const sessionIdRef = useRef("");

  useEffect(() => {
    if (!sessionIdRef.current) {
      const id = typeof window !== "undefined" && "crypto" in window && "randomUUID" in window.crypto
        ? window.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      sessionIdRef.current = `${encodeURIComponent(currentUser || "you")}::${id}`;
    }
    const es = new EventSource(`/api/game-hub/servers/${name}/presence?sessionId=${sessionIdRef.current}`);
    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as PresencePayload;
        setViewers(payload.viewers ?? []);
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [currentUser, name]);

  if (viewers.length <= 1) return null;
  const visible = viewers.slice(0, 3);
  const extra = viewers.length - visible.length;
  return (
    <div className="flex items-center gap-1" title={viewers.map((viewer) => viewer.name).join(", ")}>
      {visible.map((viewer) => (
        <span
          key={`${viewer.name}-${viewer.initial}`}
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: hashColor(viewer.name) }}
        >
          {viewer.initial}
        </span>
      ))}
      {extra > 0 ? (
        <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-white/10 px-1 text-[10px] text-gray-300">
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

function HealthOverlay({ name, visible, restartCount }: { name: string; visible: boolean; restartCount?: number }) {
  const [point, setPoint] = useState<MetricPoint | null>(null);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetchJson<MetricsResponse>(`/api/game-hub/servers/${name}/metrics`);
        const points = Array.isArray(response) ? response : response.points ?? [];
        if (!cancelled) setPoint(points[points.length - 1] ?? null);
      } catch {
        if (!cancelled) setPoint(null);
      }
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [name, visible]);

  if (!visible || !point) return null;
  const cpuPercent = point.cpuLimit > 0 ? Math.round((point.cpu / point.cpuLimit) * 100) : 0;
  const ramPercent = point.memoryLimit > 0 ? Math.round((point.memory / point.memoryLimit) * 100) : 0;
  const tone = (value: number) => (value > 85 ? "text-red-300" : value >= 60 ? "text-yellow-300" : "text-green-300");
  return (
    <div className="pointer-events-none absolute bottom-2 right-2 z-20 rounded-lg bg-black/60 px-2 py-1 text-[10px] font-mono backdrop-blur">
      <div className={tone(cpuPercent)}>CPU {cpuPercent}%</div>
      <div className={tone(ramPercent)}>RAM {ramPercent}%</div>
      {restartCount && restartCount > 0 ? <div className="text-orange-300">RST {restartCount}</div> : null}
    </div>
  );
}

export function ConsoleTab({
  name,
  status,
  server,
  currentUser,
}: {
  name: string;
  status: string;
  server: ServerDetail;
  currentUser?: string;
}) {
  const queryClient = useQueryClient();
  const userName = currentUser ?? "you";
  const [logLines, setLogLines] = useState<ConsoleLogEntry[]>([]);
  const [command, setCommand] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [podLabel, setPodLabel] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [logFilterMode, setLogFilterMode] = useState(true);
  const [history, setHistory] = useState<string[]>(() => readConsoleHistory(name));
  const [reconnectBanner, setReconnectBanner] = useState<string | null>(null);
  const [startingServer, setStartingServer] = useState(false);
  const [autoScroll, setAutoScroll] = useState(() => readConsolePrefs().autoScroll !== false);
  const [showTimestamps, setShowTimestamps] = useState(() => readConsolePrefs().showTimestamps !== false);
  const [wordWrap, setWordWrap] = useState(() => readConsolePrefs().wordWrap !== false);
  const [levelFilter, setLevelFilter] = useState<"all" | "error" | "warn" | "info">(
    () => readConsolePrefs().levelFilter ?? "all",
  );
  const [regexMode, setRegexMode] = useState(() => Boolean(readConsolePrefs().regexMode));
  const [historyDepth, setHistoryDepth] = useState<ConsoleHistoryDepth>(() => readConsolePrefs().historyDepth ?? "1d");
  const [fontSize, setFontSize] = useState(() => Math.min(18, Math.max(9, readConsolePrefs().fontSize ?? 12)));
  const [theme, setTheme] = useState<ConsoleThemeName>(() => readConsolePrefs().theme ?? "dark");
  const [showLineNumbers, setShowLineNumbers] = useState(() => Boolean(readConsolePrefs().showLineNumbers));
  const [lineHeight, setLineHeight] = useState<LineHeightMode>(() => readConsolePrefs().lineHeight ?? "comfortable");
  const [showConsoleOptions, setShowConsoleOptions] = useState(false);
  const [showCommandsPanel, setShowCommandsPanel] = useState(false);
  const [showHistorySearch, setShowHistorySearch] = useState(false);
  const [templateModal, setTemplateModal] = useState<TemplateModalState | null>(null);
  const [showMacros, setShowMacros] = useState(false);
  const [showHighlights, setShowHighlights] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [xtermMode, setXtermMode] = useState(false);
  const [highlightRules, setHighlightRules] = useState<HighlightRule[]>(() => readLocalArray(`${HIGHLIGHT_KEY_PREFIX}:${name}`, []));
  const [alertRules, setAlertRules] = useState<AlertRule[]>(() => readLocalArray(`${ALERTS_KEY_PREFIX}:${name}`, []));
  const [macros, setMacros] = useState<MacroSequence[]>(() => readLocalArray(`${MACROS_KEY_PREFIX}:${name}`, []));
  const [draftMacroName, setDraftMacroName] = useState("");
  const [draftMacroSteps, setDraftMacroSteps] = useState<MacroStep[]>([{ command: "", delayMs: 500 }]);
  const [runningMacro, setRunningMacro] = useState<{ name: string; step: number; total: number } | null>(null);
  const [playerNames, setPlayerNames] = useState<string[]>([]);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<number>>(() => new Set());
  const [activeBookmarkId, setActiveBookmarkId] = useState<number | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const [warnCount, setWarnCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [recentErrorTimes, setRecentErrorTimes] = useState<number[]>([]);
  const [recentWarnTimes, setRecentWarnTimes] = useState<number[]>([]);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<number>>(() => new Set());
  const [showOverlay, setShowOverlay] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [recordingLines, setRecordingLines] = useState<RecordingLine[]>([]);
  const [replayState, setReplayState] = useState<ReplayState>({
    status: "idle",
    data: null,
    nextIndex: 0,
    elapsedMs: 0,
    startedAtMs: null,
  });
  const [useRcon, setUseRcon] = useState(false);
  const [scheduledCommands, setScheduledCommands] = useState<ScheduledCommand[]>([]);
  const [pasteGuardItems, setPasteGuardItems] = useState<PasteGuardItem[] | null>(null);
  const [highlightDraftPattern, setHighlightDraftPattern] = useState("");
  const [highlightDraftColor, setHighlightDraftColor] = useState<HighlightColor>("yellow");
  const [alertDraftPattern, setAlertDraftPattern] = useState("");
  const [alertDraftSound, setAlertDraftSound] = useState<AlertRule["sound"]>("ping");
  const [alertDraftNotify, setAlertDraftNotify] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [transportLabel, setTransportLabel] = useState<"stdin" | "rcon">("stdin");

  const logEndRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const consoleScrollRef = useRef<HTMLDivElement>(null);
  // Ref mirrors autoScroll state but updates synchronously in the scroll handler,
  // preventing a React state-commit race that would scroll users back to the bottom
  // mid-scroll (especially noticeable on mobile with smooth-scroll momentum).
  const autoScrollRef = useRef(autoScroll);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const logIdRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const historyIdxRef = useRef(-1);
  const lastLogTimestampRef = useRef<string | null>(null);
  const hasConnectedRef = useRef(false);
  const connectRef = useRef<(depth?: ConsoleHistoryDepth) => void>(() => undefined);
  const bannerTimeoutRef = useRef<number | null>(null);
  const draftCommandRef = useRef("");
  const seenLogKeysRef = useRef(new Set<string>());
  const historyEndSeenRef = useRef(false);
  const historyReplayDoneRef = useRef(false);
  const macroTimerRef = useRef<number | null>(null);
  const replayTimerRef = useRef<number | null>(null);
  const replayBaseElapsedRef = useRef(0);
  const replayRunStartRef = useRef<number | null>(null);
  const recordingRef = useRef(false);
  const lastPlayerToastRef = useRef(0);

  const eggCommands = normalizeQuickCommands(server.egg?.quickCommands);
  const savedCommands = normalizeSavedCommands(server.savedCommands);
  const isConnected = status !== "stopped" && connected;
  const canStartServer = server.permissions?.canStart ?? true;
  const maxLines = HISTORY_DEPTH_MAX_LINES[historyDepth];
  const themeStyle = buildThemeStyle(theme);
  const currentTheme = THEME_MAP[theme];
  const lineHeightClass = lineHeight === "compact" ? "leading-[1.4]" : "leading-[1.7]";

  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        CONSOLE_PREFS_KEY,
        JSON.stringify({
          autoScroll,
          showTimestamps,
          wordWrap,
          levelFilter,
          regexMode,
          historyDepth,
          fontSize,
          theme,
          showLineNumbers,
          lineHeight,
        }),
      );
    } catch {
      // ignore
    }
  }, [autoScroll, fontSize, historyDepth, levelFilter, lineHeight, regexMode, showLineNumbers, showTimestamps, theme, wordWrap]);

  useEffect(() => {
    setLogLines((prev) => prev.slice(-maxLines));
  }, [maxLines]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${CONSOLE_HISTORY_KEY}:${name}`, JSON.stringify(history.slice(0, 50)));
    } catch {
      // ignore
    }
  }, [history, name]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${HIGHLIGHT_KEY_PREFIX}:${name}`, JSON.stringify(highlightRules));
    } catch {
      // ignore
    }
  }, [highlightRules, name]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${ALERTS_KEY_PREFIX}:${name}`, JSON.stringify(alertRules));
    } catch {
      // ignore
    }
  }, [alertRules, name]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`${MACROS_KEY_PREFIX}:${name}`, JSON.stringify(macros));
    } catch {
      // ignore
    }
  }, [macros, name]);

  useEffect(() => {
    const onFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      if (event.key === "Escape" && document.activeElement === searchRef.current) {
        setLogSearch("");
        searchRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return () => {
      if (retryRef.current) window.clearTimeout(retryRef.current);
      if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current);
      if (macroTimerRef.current) window.clearTimeout(macroTimerRef.current);
      if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
      esRef.current?.close();
      scheduledCommands.forEach((entry) => window.clearTimeout(entry.timerId));
    };
  }, [scheduledCommands]);

  useEffect(() => {
    if (typeof Notification !== "undefined") setNotificationPermission(Notification.permission);
  }, []);

  useEffect(() => {
    // When new log lines arrive, scroll only if the ref says yes.
    // Using the ref (not state) avoids the race where setAutoScroll(false) hasn't
    // committed yet when this effect fires — which was scrolling users back down.
    // Scroll the console container directly (not scrollIntoView) so we never move
    // the surrounding page, and so scrolling up to read history is never interrupted.
    if (autoScrollRef.current && !xtermMode) {
      const element = consoleScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    }
  }, [logLines, xtermMode]);

  // Keep the ref in sync when the user toggles auto-scroll via the button, and
  // immediately jump to the bottom when re-enabling.
  useEffect(() => {
    autoScrollRef.current = autoScroll;
    if (autoScroll && !xtermMode) {
      const element = consoleScrollRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    }
  }, [autoScroll, xtermMode]);

  const addLine = useCallback(
    (
      type: string,
      line: string,
      timestamp?: string | null,
      options?: { user?: string; trackStats?: boolean },
    ) => {
      const entry: ConsoleLogEntry = {
        type,
        line,
        timestamp,
        id: logIdRef.current++,
        user: options?.user,
        receivedAt: Date.now(),
      };
      setLogLines((prev) => [...prev.slice(-(maxLines - 1)), entry]);
      if (recordingRef.current) {
        setRecordingLines((prev) => [...prev, { at: Date.now(), type, line, timestamp, user: options?.user }]);
      }
      if (options?.trackStats !== false && type !== "system" && type !== "history-marker" && type !== "input") {
        setTotalCount((count) => count + 1);
        const level = detectLogLevel(type, line);
        if (level === "error") {
          setErrorCount((count) => count + 1);
          setRecentErrorTimes((prev) => [...prev, Date.now()].slice(-500));
        } else if (level === "warn") {
          setWarnCount((count) => count + 1);
          setRecentWarnTimes((prev) => [...prev, Date.now()].slice(-500));
        }
      }
      return entry;
    },
    [maxLines],
  );

  const showBanner = useCallback((message: string | null, durationMs?: number) => {
    if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current);
    setReconnectBanner(message);
    if (message && durationMs) {
      bannerTimeoutRef.current = window.setTimeout(() => setReconnectBanner(null), durationMs);
    }
  }, []);

  const clearLogs = useCallback(() => {
    setLogLines([]);
    setSelectedLineIds(new Set());
    setBookmarkedIds(new Set());
    setActiveBookmarkId(null);
    setErrorCount(0);
    setWarnCount(0);
    setTotalCount(0);
    setRecentErrorTimes([]);
    setRecentWarnTimes([]);
  }, []);

  const playAlertSound = useCallback((sound: AlertRule["sound"]) => {
    if (sound === "none" || typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const notes =
      sound === "ping"
        ? [880]
        : sound === "beep"
          ? [540, 540]
          : [523, 659, 784];
    let offset = context.currentTime;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = sound === "chime" ? "sine" : "square";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, offset);
      gain.gain.exponentialRampToValueAtTime(0.08, offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, offset + 0.12 + index * 0.01);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(offset);
      oscillator.stop(offset + 0.15);
      offset += sound === "beep" ? 0.16 : 0.18;
    });
    window.setTimeout(() => void context.close(), 400);
  }, []);

  const maybeTriggerAlerts = useCallback(
    (line: string) => {
      alertRules.forEach((rule) => {
        if (!matchesPattern(line, rule.pattern)) return;
        playAlertSound(rule.sound);
        if (rule.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification(`${name} alert`, { body: line });
        }
      });
    },
    [alertRules, name, playAlertSound],
  );

  const maybeTriggerPlayerToast = useCallback(
    (line: string) => {
      if ((server.egg as (ServerDetail["egg"] & { playerEventToasts?: boolean }) | undefined)?.playerEventToasts === false) {
        return;
      }
      if (!historyReplayDoneRef.current) return;
      if (Date.now() - lastPlayerToastRef.current < 1000) return;
      if (/\b(joined|connected|logged in)\b/i.test(line)) {
        toast.success("🎮 Player joined", { duration: 2000 });
      } else if (/\b(left|disconnected|logged out)\b/i.test(line)) {
        toast.success("👋 Player left", { duration: 2000 });
      } else if (/\b(was killed|died|was slain)\b/i.test(line)) {
        toast.error("💀 Player died", { duration: 2000 });
      } else {
        return;
      }
      lastPlayerToastRef.current = Date.now();
    },
    [server.egg],
  );

  const connect = useCallback(
    (depthOverride?: ConsoleHistoryDepth) => {
      if (status === "stopped") return;
      if (retryRef.current) window.clearTimeout(retryRef.current);
      esRef.current?.close();
      if (depthOverride !== undefined) {
        seenLogKeysRef.current.clear();
        historyEndSeenRef.current = false;
        historyReplayDoneRef.current = false;
        lastLogTimestampRef.current = null;
      }

      const params = new URLSearchParams();
      const depth = depthOverride ?? historyDepth;
      const capLines = Math.min(HISTORY_DEPTH_MAX_LINES[depth] ?? 500, 2000);
      params.set("tail", String(capLines));
      if (lastLogTimestampRef.current) params.set("sinceTime", lastLogTimestampRef.current);
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
              addLine("system", `▶ Connected to ${msg.pod ?? name}`, undefined, { trackStats: false });
              hasConnectedRef.current = true;
            } else if (isReconnect) {
              showBanner("Reconnected", 2500);
            }
            return;
          }
          if (msg.type === "history-end") {
            if (!historyEndSeenRef.current) historyEndSeenRef.current = true;
            historyReplayDoneRef.current = true;
            return;
          }
          if ((msg.type === "log" || msg.type === "error") && msg.line) {
            const lineTimestamp = msg.timestamp ?? msg.line.match(ISO_TIMESTAMP_PREFIX)?.[0]?.trim() ?? null;
            if (lineTimestamp) lastLogTimestampRef.current = lineTimestamp;
            const cleanLine = msg.line.replace(ISO_TIMESTAMP_PREFIX, "");
            const content = cleanLine || msg.line;
            const isNoise = /Thread RCON Client .+(started|shutting down)/i.test(content) || /^\s*$/.test(content);
            if (isNoise) return;
            const dedupeKey = `${lineTimestamp ?? ""}|${content.slice(0, 120)}`;
            if (seenLogKeysRef.current.has(dedupeKey)) return;
            seenLogKeysRef.current.add(dedupeKey);
            if (seenLogKeysRef.current.size > 5000) {
              const iter = seenLogKeysRef.current.values();
              for (let index = 0; index < 1000; index += 1) {
                const { value, done } = iter.next();
                if (done) break;
                seenLogKeysRef.current.delete(value);
              }
            }
            addLine(msg.type === "error" ? "error" : "log", content, lineTimestamp);
            maybeTriggerAlerts(content);
            maybeTriggerPlayerToast(content);
          }
        } catch {
          // ignore keepalive
        }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        const delay = Math.min(2000 * 2 ** retryCountRef.current, 30000);
        retryCountRef.current += 1;
        if (hasConnectedRef.current && delay >= 8000) {
          showBanner(`Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`);
        }
        retryRef.current = window.setTimeout(() => connectRef.current(), delay);
      };
    },
    [addLine, historyDepth, maybeTriggerAlerts, maybeTriggerPlayerToast, name, showBanner, status],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    if (status === "stopped") {
      esRef.current?.close();
      if (retryRef.current) window.clearTimeout(retryRef.current);
      if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current);
      return undefined;
    }
    retryCountRef.current = 0;
    connect();
    return () => {
      if (retryRef.current) window.clearTimeout(retryRef.current);
      if (bannerTimeoutRef.current) window.clearTimeout(bannerTimeoutRef.current);
      esRef.current?.close();
    };
  }, [connect, status]);

  useEffect(() => {
    let cancelled = false;
    const loadPlayers = async () => {
      try {
        const result = await fetchJson<{ players: Array<{ name: string }> }>(`/api/game-hub/servers/${name}/players`);
        if (!cancelled) setPlayerNames(result.players.map((player) => player.name));
      } catch {
        if (!cancelled) setPlayerNames([]);
      }
    };
    void loadPlayers();
    const interval = window.setInterval(() => {
      void loadPlayers();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [name]);

  const executeImmediateCommand = useCallback(
    async (rawCommand: string, options?: { keepInput?: boolean; historyEntry?: string }) => {
      const trimmed = rawCommand.trim();
      if (!trimmed || trimmed.length > 512) {
        if (trimmed.length > 512) toast.error("Command too long (max 512 chars)");
        return false;
      }
      setSending(true);
      if (!options?.keepInput) {
        setCommand("");
        historyIdxRef.current = -1;
        draftCommandRef.current = "";
      }
      const historyValue = options?.historyEntry ?? trimmed;
      setHistory((prev) => [historyValue, ...prev.filter((entry) => entry !== historyValue)].slice(0, 50));
      addLine("input", trimmed, new Date().toISOString(), { user: userName, trackStats: false });
      try {
        if (useRcon) {
          setTransportLabel("rcon");
          const result = await fetchJson<{ output?: string; error?: string }>(`/api/game-hub/servers/${name}/rcon`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: trimmed }),
          });
          if (result.output) {
            result.output
              .split("\n")
              .filter(Boolean)
              .forEach((line) => addLine("output", line, new Date().toISOString()));
          }
          if (result.error) addLine("error", result.error, new Date().toISOString());
        } else {
          setTransportLabel("stdin");
          const result = await fetchJson<{ stdout?: string; stderr?: string; error?: string; method?: string; note?: string }>(`/api/game-hub/servers/${name}/command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: trimmed }),
          });
          if (result.error) addLine("error", result.error, new Date().toISOString());
          if (result.stdout) {
            result.stdout
              .split("\n")
              .filter(Boolean)
              .forEach((line) => addLine("output", line, new Date().toISOString()));
          }
          if (result.stderr) {
            result.stderr
              .split("\n")
              .filter(Boolean)
              .forEach((line) => addLine("error", line, new Date().toISOString()));
          }
          if (result.method === "stdin-noninteractive" || result.note) {
            const note = result.note
              ?? "This game has no console/RCON command interpreter — your input was delivered via stdin but the game ignores it.";
            addLine("system", note, new Date().toISOString(), { trackStats: false });
          }
        }
        return true;
      } catch (error) {
        addLine("error", String(error), new Date().toISOString());
        if (useRcon) {
          setUseRcon(false);
          setTransportLabel("stdin");
          toast.error("RCON failed — reverted to stdin");
        }
        return false;
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [addLine, name, useRcon, userName],
  );

  const scheduleCommand = useCallback(
    (scheduled: ScheduledSpec) => {
      const delayMs = Math.max(0, scheduled.fireAt - Date.now());
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timerId = window.setTimeout(() => {
        setScheduledCommands((prev) => prev.filter((entry) => entry.id !== id));
        void executeImmediateCommand(scheduled.command, { historyEntry: `⏰ ${scheduled.command}` });
      }, delayMs);
      setScheduledCommands((prev) => [...prev, { id, command: scheduled.command, fireAt: scheduled.fireAt, timerId }]);
      toast.success(`Scheduled command for ${new Date(scheduled.fireAt).toLocaleTimeString()}`);
    },
    [executeImmediateCommand],
  );

  const processCommand = useCallback(
    async (rawCommand: string, options?: { bypassSchedule?: boolean; bypassTemplate?: boolean; historyEntry?: string }) => {
      const trimmed = rawCommand.trim();
      if (!trimmed || sending) return;
      const scheduled = options?.bypassSchedule ? null : parseScheduledCommand(trimmed);
      const effectiveCommand = scheduled ? scheduled.command : trimmed;
      if (!effectiveCommand) return;
      if (!options?.bypassTemplate && effectiveCommand.includes("{{") && effectiveCommand.includes("}}")) {
        const vars = extractTemplateVars(effectiveCommand);
        setTemplateModal({
          template: effectiveCommand,
          schedule: scheduled,
          values: Object.fromEntries(vars.map((variable) => [variable, ""])),
        });
        return;
      }
      if (scheduled) {
        scheduleCommand(scheduled);
        setCommand("");
        historyIdxRef.current = -1;
        draftCommandRef.current = "";
        return;
      }
      await executeImmediateCommand(effectiveCommand, { historyEntry: options?.historyEntry });
    },
    [executeImmediateCommand, scheduleCommand, sending],
  );

  async function sendCommand(event: FormEvent) {
    event.preventDefault();
    await processCommand(command);
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
      if (entry.id) body.commandId = entry.id;
      else {
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
      window.localStorage.removeItem(`${CONSOLE_HISTORY_KEY}:${name}`);
    } catch {
      // ignore
    }
    toast.success("Command history cleared");
  }

  const regexError = useMemo(() => {
    if (!regexMode || !logSearch.trim()) return null;
    try {
      new RegExp(logSearch, "i");
      return null;
    } catch {
      return "Invalid regex";
    }
  }, [logSearch, regexMode]);

  const visibleLogLines = useMemo(
    () =>
      logLines.filter((entry) => {
        if (entry.type === "history-marker") return true;
        if (levelFilter === "all") return true;
        return detectLogLevel(entry.type, entry.line) === levelFilter;
      }),
    [levelFilter, logLines],
  );

  const lineMatchesSearch = useCallback(
    (entry: ConsoleLogEntry) => {
      if (!logSearch.trim()) return false;
      const value = renderEntryLine(entry, showTimestamps);
      if (regexMode && !regexError) {
        return new RegExp(logSearch, "i").test(value);
      }
      return value.toLowerCase().includes(logSearch.trim().toLowerCase());
    },
    [logSearch, regexError, regexMode, showTimestamps],
  );

  const matchingLineIds = useMemo(
    () => (logSearch.trim() ? visibleLogLines.filter((entry) => lineMatchesSearch(entry)).map((entry) => entry.id) : []),
    [lineMatchesSearch, logSearch, visibleLogLines],
  );

  const displayedLogLines = useMemo(() => {
    if (!logSearch.trim() || !logFilterMode || xtermMode) return visibleLogLines;
    return visibleLogLines.filter((entry) => lineMatchesSearch(entry));
  }, [lineMatchesSearch, logFilterMode, logSearch, visibleLogLines, xtermMode]);

  const firstErrorId = useMemo(
    () => displayedLogLines.find((entry) => detectLogLevel(entry.type, entry.line) === "error")?.id ?? null,
    [displayedLogLines],
  );

  const displayedBookmarkIds = useMemo(
    () => displayedLogLines.filter((entry) => bookmarkedIds.has(entry.id)).map((entry) => entry.id),
    [bookmarkedIds, displayedLogLines],
  );

  const autocompleteCandidates = useMemo(() => {
    const value = command.trim().toLowerCase();
    if (value.length < 2) return [] as string[];
    const pool = new Set<string>([
      ...eggCommands.map((entry) => entry.command),
      ...savedCommands.map((entry) => entry.command ?? ""),
      ...playerNames,
    ]);
    return Array.from(pool)
      .filter((entry) => entry.toLowerCase().includes(value) && entry !== command)
      .slice(0, 8);
  }, [command, eggCommands, playerNames, savedCommands]);

  const errorsPerMin = useMemo(() => recentErrorTimes.filter((time) => nowTick - time <= 60_000).length, [nowTick, recentErrorTimes]);
  const warnsPerMin = useMemo(() => recentWarnTimes.filter((time) => nowTick - time <= 60_000).length, [nowTick, recentWarnTimes]);

  const handleConsoleScroll = () => {
    const element = consoleScrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    autoScrollRef.current = nearBottom; // synchronous — stops the scroll-back race
    setAutoScroll(nearBottom);
  };

  function toggleBookmark(id: number) {
    setBookmarkedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setActiveBookmarkId(id);
  }

  function navigateBookmark(direction: -1 | 1) {
    if (displayedBookmarkIds.length === 0) return;
    if (xtermMode) setXtermMode(false);
    const currentIndex = activeBookmarkId == null ? -1 : displayedBookmarkIds.indexOf(activeBookmarkId);
    const fallbackIndex = direction === 1 ? 0 : displayedBookmarkIds.length - 1;
    const nextIndex =
      currentIndex === -1
        ? fallbackIndex
        : (currentIndex + direction + displayedBookmarkIds.length) % displayedBookmarkIds.length;
    const nextId = displayedBookmarkIds[nextIndex] ?? displayedBookmarkIds[0];
    setActiveBookmarkId(nextId ?? null);
    window.setTimeout(() => lineRefs.current[nextId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }

  function jumpToFirstError() {
    if (firstErrorId == null) return;
    if (xtermMode) setXtermMode(false);
    window.setTimeout(() => lineRefs.current[firstErrorId]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
  }

  async function shareConsole() {
    try {
      const result = await fetchJson<{ token: string }>(`/api/game-hub/servers/${name}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "console-share" }),
      });
      const url = `${window.location.origin}/game-hub-status?server=${encodeURIComponent(name)}&token=${encodeURIComponent(result.token)}`;
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied");
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.ctrlKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      setShowHistorySearch(true);
      return;
    }
    if (event.key === "Tab" && autocompleteCandidates.length > 0) {
      event.preventDefault();
      setCommand(autocompleteCandidates[0] ?? command);
      setAutocompleteOpen(false);
      return;
    }
    if (event.key === "Escape") {
      setAutocompleteOpen(false);
      return;
    }
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

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted.includes("\n")) return;
    event.preventDefault();
    const items = pasted
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => ({ id: `${index}-${line}`, line, checked: true }));
    if (items.length > 0) setPasteGuardItems(items);
  }

  function updateDraftMacroStep(index: number, field: keyof MacroStep, value: string) {
    setDraftMacroSteps((prev) =>
      prev.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              [field]: field === "delayMs" ? Math.max(0, Number.parseInt(value || "0", 10) || 0) : value,
            }
          : step,
      ),
    );
  }

  function saveMacro() {
    const nameValue = draftMacroName.trim();
    const steps = draftMacroSteps.filter((step) => step.command.trim().length > 0);
    if (!nameValue || steps.length === 0) {
      toast.error("Macro needs a name and at least one step");
      return;
    }
    setMacros((prev) => [...prev.filter((macro) => macro.name !== nameValue), { name: nameValue, steps }]);
    setDraftMacroName("");
    setDraftMacroSteps([{ command: "", delayMs: 500 }]);
    toast.success("Macro saved");
  }

  function deleteMacro(nameValue: string) {
    setMacros((prev) => prev.filter((macro) => macro.name !== nameValue));
  }

  function cancelRunningMacro() {
    if (macroTimerRef.current) window.clearTimeout(macroTimerRef.current);
    macroTimerRef.current = null;
    setRunningMacro(null);
  }

  function runMacro(macro: MacroSequence) {
    cancelRunningMacro();
    const steps = macro.steps.filter((step) => step.command.trim());
    if (steps.length === 0) return;
    const runStep = async (index: number) => {
      setRunningMacro({ name: macro.name, step: index + 1, total: steps.length });
      await executeImmediateCommand(steps[index]?.command ?? "", { historyEntry: `[macro] ${steps[index]?.command ?? ""}` });
      if (index >= steps.length - 1) {
        setRunningMacro(null);
        return;
      }
      macroTimerRef.current = window.setTimeout(() => {
        void runStep(index + 1);
      }, steps[index + 1]?.delayMs ?? 0);
    };
    void runStep(0);
  }

  function cancelScheduledCommand(id: string) {
    setScheduledCommands((prev) => {
      const target = prev.find((entry) => entry.id === id);
      if (target) window.clearTimeout(target.timerId);
      return prev.filter((entry) => entry.id !== id);
    });
  }

  function exportSelectedLines() {
    const selected = displayedLogLines.filter((entry) => selectedLineIds.has(entry.id));
    downloadTextFile(
      `${name}-selected-console-${new Date().toISOString().slice(0, 10)}.txt`,
      selected.map((entry) => renderEntryLine(entry, showTimestamps)).join("\n"),
    );
  }

  function startRecording() {
    setRecordingLines([]);
    setRecordingStartedAt(Date.now());
    setRecording(true);
  }

  function stopRecording() {
    if (!recordingStartedAt) {
      setRecording(false);
      return;
    }
    const payload: RecordingExport = {
      server: name,
      startedAt: new Date(recordingStartedAt).toISOString(),
      lines: recordingLines,
    };
    downloadTextFile(
      `${name}-console-recording-${new Date(recordingStartedAt).toISOString().replace(/[:.]/g, "-")}.json`,
      JSON.stringify(payload, null, 2),
      "application/json",
    );
    setRecording(false);
    setRecordingStartedAt(null);
    toast.success("Recording saved");
  }

  function stopReplay() {
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    replayTimerRef.current = null;
    replayBaseElapsedRef.current = 0;
    replayRunStartRef.current = null;
    setReplayState((prev) => ({ ...prev, status: "idle", data: prev.data, nextIndex: 0, elapsedMs: 0, startedAtMs: null }));
  }

  const scheduleReplay = useCallback(
    (data: RecordingExport, nextIndex: number, elapsedMs: number) => {
      if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
      if (nextIndex >= data.lines.length) {
        setReplayState((prev) => ({ ...prev, status: "idle", nextIndex: data.lines.length, elapsedMs, startedAtMs: null }));
        replayTimerRef.current = null;
        return;
      }
      const firstAt = data.lines[0]?.at ?? 0;
      const targetOffset = Math.max(0, (data.lines[nextIndex]?.at ?? firstAt) - firstAt);
      const delay = Math.max(0, targetOffset - elapsedMs);
      replayBaseElapsedRef.current = elapsedMs;
      replayRunStartRef.current = Date.now();
      replayTimerRef.current = window.setTimeout(() => {
        const line = data.lines[nextIndex];
        if (line) addLine(line.type, line.line, line.timestamp ?? null, { user: line.user, trackStats: false });
        const newElapsed = Math.max(targetOffset, elapsedMs);
        setReplayState((prev) => ({ ...prev, nextIndex: nextIndex + 1, elapsedMs: newElapsed }));
        scheduleReplay(data, nextIndex + 1, newElapsed);
      }, delay);
    },
    [addLine],
  );

  function startReplay(data?: RecordingExport) {
    const replayData = data ?? replayState.data;
    if (!replayData) return;
    clearLogs();
    setReplayState({ status: "playing", data: replayData, nextIndex: 0, elapsedMs: 0, startedAtMs: Date.now() });
    scheduleReplay(replayData, 0, 0);
  }

  function pauseReplay() {
    if (replayTimerRef.current) window.clearTimeout(replayTimerRef.current);
    replayTimerRef.current = null;
    const elapsed = replayBaseElapsedRef.current + (replayRunStartRef.current ? Date.now() - replayRunStartRef.current : 0);
    setReplayState((prev) => ({ ...prev, status: "paused", elapsedMs: elapsed, startedAtMs: null }));
  }

  function resumeReplay() {
    if (!replayState.data) return;
    setReplayState((prev) => ({ ...prev, status: "playing", startedAtMs: Date.now() }));
    scheduleReplay(replayState.data, replayState.nextIndex, replayState.elapsedMs);
  }

  async function handleReplayImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as RecordingExport;
      setReplayState({ status: "idle", data: parsed, nextIndex: 0, elapsedMs: 0, startedAtMs: null });
      startReplay(parsed);
      toast.success("Replay loaded");
    } catch (error) {
      toast.error(String(error));
    } finally {
      event.target.value = "";
    }
  }

  function handleTemplateSend() {
    if (!templateModal) return;
    const resolved = substituteTemplate(templateModal.template, templateModal.values).trim();
    const scheduled = templateModal.schedule ? { ...templateModal.schedule, command: resolved } : null;
    setTemplateModal(null);
    if (!resolved) return;
    if (scheduled) {
      scheduleCommand(scheduled);
      setCommand("");
      return;
    }
    void executeImmediateCommand(resolved);
  }

  async function sendPasteGuardCommands() {
    const items = pasteGuardItems?.filter((item) => item.checked) ?? [];
    setPasteGuardItems(null);
    for (const item of items) {
      await executeImmediateCommand(item.line, { historyEntry: item.line });
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }

  const highlightRuleForLine = useCallback(
    (line: string) => highlightRules.find((rule) => matchesPattern(line, rule.pattern)) ?? null,
    [highlightRules],
  );

  return (
    <div
      ref={wrapperRef}
      data-theme={theme}
      style={{ ...themeStyle, backgroundColor: "var(--console-bg)", color: "var(--console-fg)" }}
      className="relative flex h-[calc(100dvh-170px)] min-h-[65vh] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-[#2a2a2a] sm:h-[calc(100dvh-280px)] sm:min-h-[360px]"
    >
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-[#1e1e1e]" style={{ backgroundColor: currentTheme.bg }}>
        <Circle className={cn("h-2 w-2 flex-shrink-0", isConnected ? "fill-green-400 text-green-400" : "fill-[#444] text-gray-400")} />
        <span className={cn("min-w-0 flex-1 truncate text-xs", isConnected ? "text-green-400" : "text-gray-400 dark:text-[#555]")}>
          {isConnected ? podLabel : status === "stopped" ? "Server stopped" : "Connecting…"}
        </span>
        <PresenceIndicator name={name} currentUser={userName} />
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", useRcon ? "bg-green-500/15 text-green-300" : "bg-white/10 text-gray-300")}>{transportLabel}</span>
        {!isConnected && status !== "stopped" ? (
          <button type="button" onClick={() => { retryCountRef.current = 0; connectRef.current(); }} className="rounded-md px-2 py-1 text-[10px] text-[#4db3ff]">
            Reconnect
          </button>
        ) : null}
        {[
          { label: autoScroll ? "Auto" : "Manual", active: autoScroll, action: () => setAutoScroll((value) => !value) },
          { label: "Time", active: showTimestamps, action: () => setShowTimestamps((value) => !value) },
          { label: "Wrap", active: wordWrap, action: () => setWordWrap((value) => !value) },
          { label: "# Lines", active: showLineNumbers, action: () => setShowLineNumbers((value) => !value) },
          { label: "Compact", active: lineHeight === "compact", action: () => setLineHeight((value) => value === "compact" ? "comfortable" : "compact") },
          { label: "⌨ xterm", active: xtermMode, action: () => setXtermMode((value) => !value) },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.action}
            className={cn(
              "rounded-md border px-2 py-1 text-[10px] transition-colors",
              item.active ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-gray-200 text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]",
            )}
          >
            {item.label}
          </button>
        ))}
        <button type="button" onClick={() => { setSelectionMode((value) => !value); if (xtermMode) setXtermMode(false); }} className={cn("rounded-md border px-2 py-1 text-[10px]", selectionMode ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-gray-200 text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]")}>☑ Select</button>
        <button type="button" onClick={() => setShowMacros((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">⚡ Macros</button>
        <button type="button" onClick={() => setShowHighlights((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">🎨 Highlights</button>
        <button type="button" onClick={() => setShowAlerts((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">🔔 Alerts</button>
        {displayedBookmarkIds.length > 0 ? (
          <>
            <button type="button" onClick={() => navigateBookmark(-1)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">⬆</button>
            <button type="button" onClick={() => navigateBookmark(1)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">⬇</button>
            <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] text-yellow-200">{displayedBookmarkIds.length}</span>
          </>
        ) : null}
        {firstErrorId != null ? (
          <button type="button" onClick={jumpToFirstError} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-orange-300 dark:border-[#2a2a2a]">⚠ Jump to Error</button>
        ) : null}
        <button type="button" onClick={() => setShowOverlay((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">overlay</button>
        <button type="button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void wrapperRef.current?.requestFullscreen(); }} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">{isFullscreen ? "Exit Fullscreen" : "⛶ Fullscreen"}</button>
        <button type="button" onClick={() => { const url = new URL(window.location.href); url.searchParams.set("consoleOnly", "1"); window.open(url.toString(), "_blank", "width=900,height=700"); }} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">↗ Pop Out</button>
        <button type="button" onClick={shareConsole} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">🔗 Share</button>
        <button type="button" onClick={() => setUseRcon((value) => !value)} className={cn("rounded-md border px-2 py-1 text-[10px]", useRcon ? "border-green-500/30 bg-green-500/15 text-green-300" : "border-gray-200 text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]")}>RCON</button>
        {recording ? (
          <button type="button" onClick={stopRecording} className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">⏹ Stop & Save</button>
        ) : (
          <button type="button" onClick={startRecording} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">⏺ Record</button>
        )}
        <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">▶ Replay</button>
        <button type="button" onClick={() => setShowConsoleOptions((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]">Options</button>
        <button type="button" onClick={() => setShowMobileSearch((value) => !value)} className="rounded-md border border-gray-200 px-2 py-1 text-[10px] text-gray-500 dark:border-[#2a2a2a] dark:text-[#777] sm:hidden">Search</button>
      </div>

      {recording && recordingStartedAt ? (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-[11px] text-red-200">
          <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" /> Recording… {formatCountdown(nowTick - recordingStartedAt)}
        </div>
      ) : null}

      {replayState.data ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white/70 px-4 py-2 text-[11px] dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/70">
          <span className="text-gray-500 dark:text-[#888]">Replay: {replayState.data.server}</span>
          {replayState.status === "playing" ? (
            <button type="button" onClick={pauseReplay} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Pause</button>
          ) : (
            <button type="button" onClick={resumeReplay} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Play</button>
          )}
          <button type="button" onClick={() => startReplay()} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Restart</button>
          <button type="button" onClick={stopReplay} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Stop</button>
        </div>
      ) : null}

      {showConsoleOptions ? (
        <div className="border-b border-gray-200 bg-white/90 px-4 py-3 dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/90">
          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_auto]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500 dark:text-[#777]">Theme</span>
              <select value={theme} onChange={(event) => setTheme(event.target.value as ConsoleThemeName)} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]">
                {Object.keys(THEME_MAP).map((themeName) => <option key={themeName} value={themeName}>{themeName}</option>)}
              </select>
              <span className="text-xs text-gray-500 dark:text-[#777]">History</span>
              <select value={historyDepth} onChange={(event) => { const depth = event.target.value as ConsoleHistoryDepth; setHistoryDepth(depth); lastLogTimestampRef.current = null; clearLogs(); connect(depth); }} className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs dark:border-[#2a2a2a] dark:bg-[#111] dark:text-[#f2f2f2]">
                <option value="1h">1h</option>
                <option value="6h">6h</option>
                <option value="1d">1d</option>
                <option value="3d">3d</option>
                <option value="7d">7d</option>
              </select>
              <button type="button" onClick={() => setRegexMode((value) => !value)} className={cn("rounded-lg border px-3 py-2 text-xs", regexMode ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-gray-200 text-gray-500 dark:border-[#2a2a2a] dark:text-[#777]")}>Regex</button>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <button type="button" onClick={() => setFontSize((value) => Math.max(9, value - 1))} className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-[#2a2a2a]">-</button>
              <input type="range" min={9} max={18} value={fontSize} onChange={(event) => setFontSize(Number.parseInt(event.target.value, 10))} className="w-28 accent-[#0078D4]" />
              <span className="min-w-12 text-center text-xs text-gray-500 dark:text-[#777]">{fontSize}px</span>
              <button type="button" onClick={() => setFontSize((value) => Math.min(18, value + 1))} className="rounded-lg border border-gray-200 px-2 py-1 text-xs dark:border-[#2a2a2a]">+</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={clearLogs} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a]">Clear</button>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(displayedLogLines.map((entry) => renderEntryLine(entry, showTimestamps)).join("\n")); toast.success("Copied"); }} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a]">Copy all</button>
              <button type="button" onClick={() => downloadTextFile(`${name}-console-${new Date().toISOString().slice(0, 10)}.txt`, displayedLogLines.map((entry) => renderEntryLine(entry, showTimestamps)).join("\n"))} className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-[#2a2a2a]">Download</button>
            </div>
          </div>
        </div>
      ) : null}

      <MacroPanel
        open={showMacros}
        macros={macros}
        draftName={draftMacroName}
        draftSteps={draftMacroSteps}
        onDraftNameChange={setDraftMacroName}
        onDraftStepChange={updateDraftMacroStep}
        onAddDraftStep={() => setDraftMacroSteps((prev) => [...prev, { command: "", delayMs: 500 }])}
        onRemoveDraftStep={(index) => setDraftMacroSteps((prev) => prev.filter((_step, stepIndex) => stepIndex !== index))}
        onSave={saveMacro}
        onRun={runMacro}
        onDelete={deleteMacro}
        running={runningMacro}
        onCancelRunning={cancelRunningMacro}
      />
      <HighlightRulesPanel
        open={showHighlights}
        rules={highlightRules}
        draftPattern={highlightDraftPattern}
        draftColor={highlightDraftColor}
        onDraftPatternChange={setHighlightDraftPattern}
        onDraftColorChange={setHighlightDraftColor}
        onAdd={() => {
          const pattern = highlightDraftPattern.trim();
          if (!pattern) return;
          setHighlightRules((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, pattern, color: highlightDraftColor }]);
          setHighlightDraftPattern("");
        }}
        onDelete={(id) => setHighlightRules((prev) => prev.filter((rule) => rule.id !== id))}
      />
      <AlertRulesPanel
        open={showAlerts}
        rules={alertRules}
        draftPattern={alertDraftPattern}
        draftSound={alertDraftSound}
        draftNotify={alertDraftNotify}
        permission={notificationPermission}
        onDraftPatternChange={setAlertDraftPattern}
        onDraftSoundChange={setAlertDraftSound}
        onDraftNotifyChange={setAlertDraftNotify}
        onAdd={() => {
          const pattern = alertDraftPattern.trim();
          if (!pattern) return;
          setAlertRules((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, pattern, sound: alertDraftSound, notify: alertDraftNotify }]);
          setAlertDraftPattern("");
          setAlertDraftNotify(false);
        }}
        onDelete={(id) => setAlertRules((prev) => prev.filter((rule) => rule.id !== id))}
        onRequestPermission={requestNotificationPermission}
      />

      <div className={cn("flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 dark:border-[#1e1e1e] dark:bg-[#101010]", !showMobileSearch && "hidden sm:flex", showMobileSearch && "flex")}>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 dark:border-[#2a2a2a] dark:bg-[#0d0d0d]">
          <Search className="h-3.5 w-3.5 text-gray-400 dark:text-[#666]" />
          <input ref={searchRef} value={logSearch} onChange={(event) => setLogSearch(event.target.value)} placeholder="Search logs…" className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none dark:text-[#f2f2f2]" />
          {logSearch ? <button type="button" onClick={() => setLogSearch("")} className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:text-[#666] dark:hover:bg-[#1a1a1a]"><X className="h-3.5 w-3.5" /></button> : null}
        </div>
        <span className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-[#bbb] dark:border-[#2a2a2a] dark:bg-[#0d0d0d]">{matchingLineIds.length} matches</span>
        <button type="button" onClick={() => setLogFilterMode((value) => !value)} className={cn("rounded-lg border px-3 py-1.5 text-[11px]", logFilterMode ? "border-[#0078D4]/30 bg-[#0078D4]/10 text-[#4db3ff]" : "border-gray-200 bg-white text-gray-500 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#888]")}>{logFilterMode ? "Filter mode" : "Dim mode"}</button>
        <select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value as "all" | "error" | "warn" | "info")} className="rounded border border-gray-200 bg-white px-2 py-1.5 text-[10px] text-[#bbb] dark:border-[#2a2a2a] dark:bg-[#0d0d0d]">
          <option value="all">All levels</option>
          <option value="error">ERROR</option>
          <option value="warn">WARN</option>
          <option value="info">INFO</option>
        </select>
        {regexError ? <span className="text-[10px] text-red-300">{regexError}</span> : null}
      </div>

      <div className="border-b border-gray-200 bg-white/70 px-4 py-1.5 text-[11px] dark:border-[#1e1e1e] dark:bg-[#0d0d0d]/70">
        <span className="text-red-300">Errors: {errorCount} ({errorsPerMin}/min)</span>
        <span className="mx-2 text-gray-500 dark:text-[#666]">·</span>
        <span className="text-yellow-300">Warnings: {warnCount} ({warnsPerMin}/min)</span>
        <span className="mx-2 text-gray-500 dark:text-[#666]">·</span>
        <span className="text-gray-300">Lines: {totalCount}</span>
      </div>

      {reconnectBanner && status !== "stopped" ? <div className="border-b border-gray-200 bg-[#111827] px-4 py-1.5 text-[11px] text-[#93c5fd] dark:border-[#1e1e1e]">{reconnectBanner}</div> : null}
      {logLines.length >= maxLines ? <div className="border-b border-[#3a2a00] bg-yellow-500/10 px-4 py-1.5 text-[11px] text-yellow-200">⚠ Display capped at {maxLines} lines</div> : null}

      <div className="relative min-h-0 flex-1">
        <div ref={consoleScrollRef} onScroll={handleConsoleScroll} className="h-full overflow-y-auto overflow-x-auto px-3 py-3 font-mono text-xs overscroll-contain select-text sm:p-4" style={{ fontSize: `${fontSize}px`, backgroundColor: currentTheme.bg, color: currentTheme.fg }}>
          {status === "stopped" ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white px-6 py-10 text-center shadow-[0_0_40px_rgba(0,0,0,0.35)] dark:border-[#2a2a2a] dark:bg-[#111]">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-400 dark:border-[#2a2a2a] dark:bg-[#0d0d0d] dark:text-[#666]"><Square className="h-8 w-8" /></div>
                <h3 className="text-2xl font-semibold text-gray-900 dark:text-[#f2f2f2]">Server Stopped</h3>
                <p className="mt-2 text-sm text-gray-400 dark:text-[#666]">Start the server to stream logs and run commands.</p>
                {canStartServer ? (
                  <button type="button" onClick={() => void startServer()} disabled={startingServer} className="mx-auto mt-6 inline-flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/20 px-4 py-2.5 text-sm font-medium text-green-200 transition-colors hover:bg-green-500/30 disabled:opacity-50">
                    {startingServer ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Start Server
                  </button>
                ) : <p className="mt-6 text-xs text-gray-400 dark:text-[#555]">You do not have permission to start this server.</p>}
              </div>
            </div>
          ) : xtermMode ? (
            <div className="h-full min-h-[320px] rounded-lg border border-gray-200 dark:border-[#2a2a2a]">
              <XtermConsole
                lines={visibleLogLines}
                fontSize={fontSize}
                theme={theme}
                searchQuery={logSearch}
                regexMode={regexMode}
                lineHeight={lineHeight}
                showTimestamps={showTimestamps}
                autoScroll={autoScroll}
              />
            </div>
          ) : displayedLogLines.length === 0 ? (
            <div className="flex items-center gap-2 pt-1 text-gray-400 dark:text-[#444]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{logLines.length === 0 ? "Connecting to log stream…" : "No logs match the current filters."}</span>
            </div>
          ) : (
            displayedLogLines.map((entry, index) => {
              if (entry.type === "history-marker") return <span key={entry.id} style={{ display: "none" }} aria-hidden="true" />;
              const selected = selectedLineIds.has(entry.id);
              const bookmarked = bookmarkedIds.has(entry.id);
              const highlightRule = highlightRuleForLine(entry.line);
              return (
                <div
                  key={entry.id}
                  ref={(element) => {
                    lineRefs.current[entry.id] = element;
                  }}
                  onClick={() => toggleBookmark(entry.id)}
                  data-user={entry.type === "input" ? entry.user ?? userName : undefined}
                  className={cn(
                    "group flex min-w-fit items-start rounded px-1 transition-opacity",
                    lineHeightClass,
                    lineColor(entry.type),
                    wordWrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
                    logSearch.trim() && !logFilterMode && !matchingLineIds.includes(entry.id) && "opacity-35",
                    matchingLineIds.includes(entry.id) && "bg-yellow-400/10",
                    highlightRule && HIGHLIGHT_CLASS_MAP[highlightRule.color],
                    bookmarked && "border-l-2 border-yellow-400 pl-1",
                  )}
                >
                  {selectionMode ? (
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        setSelectedLineIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(entry.id)) next.delete(entry.id);
                          else next.add(entry.id);
                          return next;
                        });
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="mr-2 mt-1"
                    />
                  ) : null}
                  {showLineNumbers ? <span className="mr-2 w-8 flex-shrink-0 select-none text-right text-gray-600 dark:text-[#444]">{index + 1}</span> : null}
                  <div className="flex-1" style={{ fontSize: `${fontSize}px` }}>
                    {regexMode ? renderEntryLine(entry, showTimestamps) : highlightLogMatch(renderEntryLine(entry, showTimestamps), logSearch)}
                  </div>
                </div>
              );
            })
          )}
          <div ref={logEndRef} />
        </div>
        <HealthOverlay name={name} visible={showOverlay} restartCount={server.restartCount} />
      </div>

      {isConnected && (eggCommands.length > 0 || savedCommands.length > 0) ? (
        <div className="flex-shrink-0 border-t border-gray-200 bg-white dark:border-[#1a1a1a] dark:bg-[#0d0d0d]">
          <button type="button" onClick={() => setShowCommandsPanel((value) => !value)} className="flex w-full items-center justify-between px-3 py-2 text-[10px] text-gray-400 transition-colors hover:text-gray-700 dark:text-[#555] dark:hover:text-[#888] sm:hidden">
            <span className="uppercase tracking-wide">Commands ({eggCommands.length + savedCommands.length})</span>
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", showCommandsPanel && "rotate-180")} />
          </button>
          <div className={cn("space-y-3 px-3 py-2", !showCommandsPanel && "hidden sm:block")}>
            {eggCommands.length > 0 ? (
              <div>
                <p className="mb-2 text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#444]">Quick Commands</p>
                <div className="overflow-x-auto scrollbar-none">
                  <div className="flex w-max gap-2 pb-1">
                    {eggCommands.map((entry) => (
                      <button
                        key={`${entry.label}-${entry.command}`}
                        type="button"
                        onClick={() => {
                          if (entry.command.includes("{{")) {
                            const vars = extractTemplateVars(entry.command);
                            setTemplateModal({ template: entry.command, schedule: null, values: Object.fromEntries(vars.map((variable) => [variable, ""])) });
                            return;
                          }
                          setCommand(entry.command);
                          inputRef.current?.focus();
                        }}
                        className="min-h-[36px] rounded-full border border-gray-200 bg-white px-3 py-1 text-[10px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-[#2a2a2a] dark:bg-[#1a1a1a] dark:text-[#777] dark:hover:bg-[#252525] dark:hover:text-[#ccc]"
                      >
                        {entry.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
            {savedCommands.length > 0 ? (
              <div>
                <p className="mb-2 text-[10px] uppercase tracking-wide text-gray-400 dark:text-[#444]">Saved Commands</p>
                <div className="overflow-x-auto scrollbar-none">
                  <div className="flex w-max gap-2 pb-1">
                    {savedCommands.map((entry) => {
                      const value = entry.command ?? "";
                      return (
                        <div key={`${entry.id ?? entry.label}-${value}`} className="flex items-center overflow-hidden rounded-full border border-gray-200 bg-white dark:border-[#2a2a2a] dark:bg-[#1a1a1a]">
                          <button type="button" onClick={() => { setCommand(value); inputRef.current?.focus(); }} className="min-h-[36px] px-3 py-1 text-[10px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-[#777] dark:hover:bg-[#252525] dark:hover:text-[#ccc]">{entry.label}</button>
                          {value.includes("{{") ? (
                            <button
                              type="button"
                              onClick={() => {
                                const vars = extractTemplateVars(value);
                                setTemplateModal({ template: value, schedule: null, values: Object.fromEntries(vars.map((variable) => [variable, ""])) });
                              }}
                              className="min-h-[36px] px-2 py-1 text-[10px] text-[#4db3ff]"
                              title="Fill template variables"
                            >
                              ✎
                            </button>
                          ) : null}
                          <button type="button" onClick={() => void deleteSavedCommand(entry)} className="min-h-[36px] px-2 py-1 text-[10px] text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-300 dark:text-[#555]">✕</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {(selectionMode || selectedLineIds.size > 0 || scheduledCommands.length > 0 || runningMacro) ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 bg-white/80 px-3 py-2 text-[11px] dark:border-[#1a1a1a] dark:bg-[#0d0d0d]/80">
          {selectionMode ? (
            <>
              <span className="text-gray-500 dark:text-[#888]">Selection mode</span>
              <button type="button" onClick={() => setSelectedLineIds(new Set(displayedLogLines.map((entry) => entry.id)))} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Select All</button>
              <button type="button" onClick={() => setSelectedLineIds(new Set())} className="rounded-md border border-gray-200 px-2 py-1 dark:border-[#2a2a2a]">Deselect All</button>
            </>
          ) : null}
          {selectedLineIds.size > 0 ? (
            <button type="button" onClick={exportSelectedLines} className="rounded-md bg-[#0078D4] px-2 py-1 text-white">Export Selected ({selectedLineIds.size})</button>
          ) : null}
          {runningMacro ? <span className="rounded-full bg-[#0078D4]/10 px-2 py-1 text-[#4db3ff]">Running macro… {runningMacro.step}/{runningMacro.total}</span> : null}
          {scheduledCommands.map((entry) => (
            <span key={entry.id} className="inline-flex items-center gap-2 rounded-full bg-white/10 px-2 py-1 text-gray-300">
              ⏰ {entry.command} in {formatCountdown(entry.fireAt - nowTick)}
              <button type="button" onClick={() => cancelScheduledCommand(entry.id)} className="text-red-300">✕</button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="sticky bottom-0 z-10 flex-shrink-0 border-t border-gray-200 bg-[#0d0d0d]/95 p-2 backdrop-blur supports-[backdrop-filter]:bg-[#0d0d0d]/85 dark:border-[#1a1a1a]">
        <form onSubmit={(event) => void sendCommand(event)} className="flex items-center gap-2">
          <div className="relative flex-1">
            <div className={cn("flex min-h-[46px] items-center gap-2 rounded-xl border bg-white px-3 dark:bg-[#111]", isConnected ? "border-gray-200 focus-within:border-[#0078D4] dark:border-[#2a2a2a]" : "border-gray-200 opacity-50 dark:border-[#1a1a1a]") }>
              <span className="select-none font-mono text-sm text-green-500">❯</span>
              <input
                ref={inputRef}
                value={command}
                onChange={(event) => { setCommand(event.target.value); setAutocompleteOpen(event.target.value.trim().length >= 2); }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onBlur={() => window.setTimeout(() => setAutocompleteOpen(false), 120)}
                placeholder={isConnected ? "Enter command… (↑↓ history, Ctrl+R search)" : "Waiting for connection…"}
                disabled={!isConnected || sending}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="flex-1 bg-transparent py-1 font-mono leading-none text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed dark:text-[#f0f0f0] dark:placeholder:text-[#333]"
                style={{ fontSize: `${fontSize}px` }}
              />
              <button type="button" onClick={saveCurrentCommand} disabled={!command.trim()} title="Save command" className="rounded p-1 text-gray-400 transition-colors hover:text-gray-700 disabled:opacity-30 dark:text-[#444] dark:hover:text-[#888] sm:hidden">
                <Save className="h-3.5 w-3.5" />
              </button>
            </div>
            {autocompleteOpen && autocompleteCandidates.length > 0 ? (
              <div className="absolute inset-x-0 top-full z-30 mt-2 rounded-xl border border-gray-200 bg-white p-1 shadow-xl dark:border-[#2a2a2a] dark:bg-[#111]">
                {autocompleteCandidates.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => { setCommand(candidate); setAutocompleteOpen(false); inputRef.current?.focus(); }}
                    className="block w-full rounded-lg px-3 py-2 text-left text-xs font-mono text-gray-700 transition-colors hover:bg-gray-100 dark:text-[#ddd] dark:hover:bg-[#1a1a1a]"
                  >
                    {candidate}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" onClick={saveCurrentCommand} disabled={!command.trim()} className="hidden min-h-[46px] rounded-xl bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:bg-[#1a1a1a] dark:text-[#cfcfcf] dark:hover:bg-[#252525] sm:inline-flex sm:items-center">Save</button>
          <button type="button" onClick={clearCommandHistory} disabled={history.length === 0} className="hidden min-h-[46px] rounded-xl bg-white px-3 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-40 dark:bg-[#1a1a1a] dark:text-[#9e9e9e] dark:hover:bg-[#252525] sm:inline-flex sm:items-center">Clear History</button>
          <button type="submit" disabled={!isConnected || sending || !command.trim()} className="inline-flex min-h-[46px] items-center justify-center rounded-xl bg-[#0078D4] px-4 text-sm font-medium text-white transition-colors hover:bg-[#0065B3] disabled:opacity-25 sm:h-11 sm:w-11 sm:px-0">
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="h-4 w-4 sm:hidden" /><span className="hidden sm:inline">Send</span><Send className="hidden h-4 w-4 sm:inline" /></>}
          </button>
        </form>
        <p className="mt-1.5 px-1 text-[10px] text-[#2a2a2a]">Universal console • ↑↓ history • Ctrl+R search</p>
      </div>

      <HistorySearchModal open={showHistorySearch} history={history} onClose={() => setShowHistorySearch(false)} onPick={(value) => { setCommand(value); setShowHistorySearch(false); inputRef.current?.focus(); }} />
      <TemplateVarModal
        state={templateModal}
        onClose={() => setTemplateModal(null)}
        onChange={(variable, value) => setTemplateModal((prev) => prev ? { ...prev, values: { ...prev.values, [variable]: value } } : prev)}
        onSend={handleTemplateSend}
      />
      <PasteGuardModal
        items={pasteGuardItems}
        onToggle={(id) => setPasteGuardItems((prev) => prev?.map((item) => item.id === id ? { ...item, checked: !item.checked } : item) ?? null)}
        onCancel={() => setPasteGuardItems(null)}
        onSend={() => void sendPasteGuardCommands()}
      />
      <input ref={fileInputRef} type="file" accept="application/json" onChange={(event) => void handleReplayImport(event)} className="hidden" />
    </div>
  );
}
