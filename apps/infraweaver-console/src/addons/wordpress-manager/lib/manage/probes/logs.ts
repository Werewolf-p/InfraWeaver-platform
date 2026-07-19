/**
 * Logs panel probe — the tail of the WordPress debug log, read live from the
 * pod. WordPress writes `wp-content/debug.log` in the classic
 * `[07-Jul-2026 12:00:00 UTC] PHP Warning: message` format; we tail it and parse
 * each header line into a typed entry. When WP_DEBUG_LOG is off (or no log file
 * exists) there is genuinely nothing to collect, so we say so rather than invent
 * entries.
 */
import { WP_SAFE, toStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type LogLevel = "Fatal error" | "Error" | "Warning" | "Notice" | "Deprecated" | "Other";

export interface LogEntry {
  /** Raw timestamp text from the log line (e.g. "07-Jul-2026 12:00:00 UTC"), or null. */
  readonly at: string | null;
  readonly level: LogLevel;
  readonly message: string;
}

export interface LogsData {
  /** True when WP_DEBUG_LOG is configured on — drives the empty-state copy. */
  readonly debugLogEnabled: boolean;
  /** Resolved log path (custom path, or the default when it is a boolean true). */
  readonly logPath: string | null;
  readonly entries: readonly LogEntry[];
  readonly counts: Readonly<Record<LogLevel, number>>;
}

const DEFAULT_LOG_PATH = "wp-content/debug.log";
/** Cap rendered entries so one runaway log can't bloat the payload. */
const MAX_ENTRIES = 200;

/** Header lines look like `[time] PHP Warning: message` (the PHP prefix is optional). */
const LINE_RE = /^\[([^\]]+)\]\s*(?:PHP\s+)?(.*)$/;

function classify(body: string): LogLevel {
  if (/^Fatal error/i.test(body) || /^Parse error/i.test(body)) return "Fatal error";
  if (/^Warning/i.test(body)) return "Warning";
  if (/^Notice/i.test(body)) return "Notice";
  if (/^Deprecated/i.test(body)) return "Deprecated";
  if (/^Error/i.test(body) || /error/i.test(body)) return "Error";
  return "Other";
}

/** Is WP_DEBUG_LOG configured to something that enables logging? */
export function debugLogValue(raw: string | null): { enabled: boolean; path: string | null } {
  if (raw === null) return { enabled: false, path: null };
  const v = raw.trim();
  const lower = v.toLowerCase();
  if (v === "" || lower === "0" || lower === "false" || lower === "off") {
    return { enabled: false, path: null };
  }
  // `1`/`true` ⇒ log to the default path; any other string ⇒ that path.
  const isBoolTrue = lower === "1" || lower === "true";
  return { enabled: true, path: isBoolTrue ? DEFAULT_LOG_PATH : v };
}

export function parseDebugLog(tail: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of tail.split("\n")) {
    const match = LINE_RE.exec(line);
    if (!match) continue; // stack-trace continuation / non-header line
    const body = match[2].trim();
    entries.push({ at: match[1].trim(), level: classify(body), message: body });
  }
  // Newest first — the log appends chronologically.
  return entries.reverse().slice(0, MAX_ENTRIES);
}

function countByLevel(entries: readonly LogEntry[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = {
    "Fatal error": 0,
    Error: 0,
    Warning: 0,
    Notice: 0,
    Deprecated: 0,
    Other: 0,
  };
  for (const entry of entries) counts[entry.level] += 1;
  return counts;
}

export function buildLogs(input: { config: string; tail: string }): LogsData {
  const { enabled, path } = debugLogValue(toStr(input.config));
  if (!enabled || input.tail.trim() === "") {
    return { debugLogEnabled: enabled, logPath: path, entries: [], counts: countByLevel([]) };
  }
  const entries = parseDebugLog(input.tail);
  return { debugLogEnabled: true, logPath: path, entries, counts: countByLevel(entries) };
}

async function fetchLogs(ctx: PanelProbeContext): Promise<LogsData> {
  const [config, tail] = await Promise.all([
    ctx.exec(`${WP_SAFE} config get WP_DEBUG_LOG 2>/dev/null`).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`tail -n ${MAX_ENTRIES} ${DEFAULT_LOG_PATH} 2>/dev/null`).then((r) => r.stdout).catch(() => ""),
  ]);
  return buildLogs({ config, tail });
}

export const logsProbe: PanelProbe<LogsData> = {
  id: "logs",
  fetch: fetchLogs,
};
