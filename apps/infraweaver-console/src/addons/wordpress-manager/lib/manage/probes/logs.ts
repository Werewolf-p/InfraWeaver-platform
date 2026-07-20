/**
 * Logs panel probe — the tail of the WordPress debug log, read live from the
 * pod. WordPress writes `wp-content/debug.log` in the classic
 * `[07-Jul-2026 12:00:00 UTC] PHP Warning: message` format; we tail it and parse
 * each header line into a typed entry. When WP_DEBUG_LOG is off (or no log file
 * exists) there is genuinely nothing to collect, so we say so rather than invent
 * entries.
 *
 * Two properties this probe must uphold so every site gives HONEST logging info:
 *   1. Read the log from the path the site actually configured. WP_DEBUG_LOG may
 *      be `true` (⇒ the default `wp-content/debug.log`) or a custom path; a site
 *      logging to a custom file must not read as "empty" because we tailed the
 *      wrong file. The path is validated (separate trust domain) before it touches
 *      a shell.
 *   2. Never conflate "we could not read it" with "logging is off". A failed
 *      config/tail read surfaces as `readError` with a plain reason, so the panel
 *      shows why the info is missing instead of falsely asserting logging is
 *      disabled (and telling the operator to "enable" something already on).
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
  /**
   * Set when the debug-log config or file could not be read from the site (exec
   * transport failure, or a custom path that can't be tailed safely). Distinct
   * from "logging is off": the panel shows this reason rather than claiming the
   * site disabled logging. `null` on a clean read.
   */
  readonly readError: string | null;
}

const DEFAULT_LOG_PATH = "wp-content/debug.log";
/** Cap rendered entries so one runaway log can't bloat the payload. */
const MAX_ENTRIES = 200;
/** Upper bound on a configured log path we will accept before refusing to tail it. */
const MAX_LOG_PATH_LEN = 512;

/** Header lines look like `[time] PHP Warning: message` (the PHP prefix is optional). */
const LINE_RE = /^\[([^\]]+)\]\s*(?:PHP\s+)?(.*)$/;

/**
 * A configured log path is a value from the site's wp-config.php — a separate
 * trust domain — so it is validated against a strict path charset before it ever
 * reaches a `tail` command. Allows absolute or relative POSIX paths of
 * slug/dot/underscore/dash segments; refuses whitespace, shell metacharacters, a
 * leading dash (so `tail` can't read it as a flag) and `..` traversal. Returns the
 * safe path, or `null` when the value can't be tailed safely.
 */
const SAFE_LOG_PATH_RE = /^\/?[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export function safeLogPath(path: string | null): string | null {
  if (path === null) return null;
  const p = path.trim();
  if (p.length === 0 || p.length > MAX_LOG_PATH_LEN) return null;
  if (!SAFE_LOG_PATH_RE.test(p)) return null;
  if (p.split("/").some((segment) => segment === "..")) return null;
  return p;
}

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

export function buildLogs(input: {
  config: string;
  tail: string;
  /** A read failure that must NOT be reported as "logging off". */
  configError?: string | null;
  /** Log file existed-check/tail failed while logging was on (path unreadable). */
  tailError?: string | null;
}): LogsData {
  const empty = countByLevel([]);
  // Could not read the config at all — say why, never assert "off".
  if (input.configError) {
    return { debugLogEnabled: false, logPath: null, entries: [], counts: empty, readError: input.configError };
  }
  const { enabled, path } = debugLogValue(toStr(input.config));
  if (!enabled) {
    return { debugLogEnabled: false, logPath: path, entries: [], counts: empty, readError: null };
  }
  // Logging is on but the file couldn't be tailed — report the reason, still true.
  if (input.tailError) {
    return { debugLogEnabled: true, logPath: path, entries: [], counts: empty, readError: input.tailError };
  }
  if (input.tail.trim() === "") {
    return { debugLogEnabled: true, logPath: path, entries: [], counts: empty, readError: null };
  }
  const entries = parseDebugLog(input.tail);
  return { debugLogEnabled: true, logPath: path, entries, counts: countByLevel(entries), readError: null };
}

/**
 * Plain, non-leaking reason for a failed pod read. A wp-cli exec that exited
 * non-zero is almost always the site's WordPress/DB briefly unavailable; other
 * faults are the exec channel itself. Never returns raw stderr (it can carry
 * paths) — the detail is already in the server log.
 */
function readErrorReason(err: unknown): string {
  // Detected by name (not `instanceof`) so this stays free of the k8s-exec module
  // — its `LogsData` type is imported by the client panel, and the value helpers
  // here (buildLogs/parseDebugLog) must not drag a Node/@kubernetes dependency in.
  if (err instanceof Error && err.name === "WpPodExecError") {
    return "The site's WordPress didn't respond as expected — its database or pod may be briefly unavailable. Retry in a moment.";
  }
  return "Couldn't read the debug log from the site — try again in a moment.";
}

async function fetchLogs(ctx: PanelProbeContext): Promise<LogsData> {
  // 1) Read WP_DEBUG_LOG. `|| true` makes an UNDEFINED constant (wp-cli exits
  //    non-zero) an empty string ⇒ correctly "off", while a genuine exec-channel
  //    failure still throws ⇒ surfaced as readError (not a false "off").
  let config = "";
  try {
    config = (await ctx.exec(`${WP_SAFE} config get WP_DEBUG_LOG 2>/dev/null || true`)).stdout;
  } catch (err) {
    return buildLogs({ config: "", tail: "", configError: readErrorReason(err) });
  }

  const { enabled, path } = debugLogValue(toStr(config));
  if (!enabled) return buildLogs({ config, tail: "" });

  // 2) Tail the RESOLVED path (custom or default) — not always the default file,
  //    which would show a custom-path site as empty. Validate first: the path
  //    comes from the site's wp-config.php.
  const target = safeLogPath(path);
  if (target === null) {
    return buildLogs({
      config,
      tail: "",
      tailError: "Debug logging is on but its log path can't be read safely from here — check WP_DEBUG_LOG in wp-config.php.",
    });
  }

  // `|| true` so a MISSING log file (logging on, nothing written yet) reads as an
  // empty tail rather than a scary error; a real exec-channel failure still throws.
  try {
    const tail = (await ctx.exec(`tail -n ${MAX_ENTRIES} ${target} 2>/dev/null || true`)).stdout;
    return buildLogs({ config, tail });
  } catch (err) {
    return buildLogs({ config, tail: "", tailError: readErrorReason(err) });
  }
}

export const logsProbe: PanelProbe<LogsData> = {
  id: "logs",
  fetch: fetchLogs,
};
