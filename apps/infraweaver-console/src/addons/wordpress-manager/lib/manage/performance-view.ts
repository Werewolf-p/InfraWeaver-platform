/**
 * Pure view-logic for the Performance surface — the FUSION core (US-4): it turns a
 * measured audit row's issue codes into recommendations that reference *our own*
 * features with their live state, so a measurement becomes a one-click remedy
 * ("slow + cache off → Enable Page Cache"; "slow + cache on → purge this URL").
 * No React, no I/O — unit-tested directly so the component stays a thin renderer.
 */

import type { AuditRow, PageCacheStatus } from "./performance";

/** The concrete remedy an audit fix points at — the action the console can take. */
export type PerfFixAction = "enable-cache" | "purge-url" | "object-cache" | "db-cleanup";

export interface PerfFix {
  /** The audit issue code this fix answers. */
  readonly issue: string;
  /** Plain-language recommendation naming *our* feature and its live state. */
  readonly label: string;
  /** What the console should offer for this fix (a button the row can wire). */
  readonly action: PerfFixAction;
}

export interface PerfFixContext {
  /** Whether the IWSL page cache is enabled right now (from perf.status). */
  readonly cacheEnabled: boolean;
}

const SLOW_ISSUES = ["slow-server-generation", "very-slow-server-generation"] as const;

/**
 * Map one measured URL's issues to feature-aware fixes. Slow generation resolves
 * to the page cache (enable when off, purge-to-refresh when already on); a high
 * query count resolves to the object cache + DB cleanup. Idempotent + order-stable.
 */
export function auditRowFixes(row: AuditRow, ctx: PerfFixContext): PerfFix[] {
  const fixes: PerfFix[] = [];
  const slowIssue = row.issues.find((i) => (SLOW_ISSUES as readonly string[]).includes(i));
  if (slowIssue) {
    fixes.push(
      ctx.cacheEnabled
        ? {
            issue: slowIssue,
            label: "Already cached — purge this URL to refresh it, or check plugin/theme weight on this page.",
            action: "purge-url",
          }
        : {
            issue: slowIssue,
            label: "Slow to build — enable Page Cache to serve this page from cache instead.",
            action: "enable-cache",
          },
    );
  }
  if (row.issues.includes("high-query-count")) {
    fixes.push({
      issue: "high-query-count",
      label: "High database query count — add a persistent object cache and run a database cleanup.",
      action: "object-cache",
    });
  }
  return fixes;
}

export type SpeedTone = "good" | "warn" | "neutral";

export interface CacheVerdict {
  readonly tone: SpeedTone;
  readonly label: string;
  /** Today's hit-rate as an integer percent (0 when no traffic yet). */
  readonly hitRate: number;
  /** True when the drop-in is present but not ours (a foreign cache plugin conflict). */
  readonly foreignDropin: boolean;
}

/**
 * A one-glance verdict for the page-cache zone from `perf.status.page_cache`. A
 * foreign drop-in (present but not ours) is called out as a conflict — our
 * `enable()` refuses to clobber it, so the console must explain rather than fight.
 */
export function cacheVerdict(status: PageCacheStatus): CacheVerdict {
  const foreignDropin = status.dropin_present && !status.dropin_is_ours;
  if (foreignDropin) {
    return { tone: "warn", label: "Another cache plugin owns the drop-in", hitRate: 0, foreignDropin: true };
  }
  if (!status.enabled) {
    return { tone: "neutral", label: "Page cache is off", hitRate: status.hit_rate, foreignDropin: false };
  }
  const served = status.hits_today + status.misses_today;
  if (served === 0) {
    return { tone: "good", label: "Page cache on — no traffic yet today", hitRate: 0, foreignDropin: false };
  }
  return {
    tone: status.hit_rate >= 50 ? "good" : "warn",
    label: `Page cache on — ${status.hit_rate}% of today's views served from cache`,
    hitRate: status.hit_rate,
    foreignDropin: false,
  };
}

/** Human-readable byte size for the cache "entries / size" line. Pure, deterministic. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
