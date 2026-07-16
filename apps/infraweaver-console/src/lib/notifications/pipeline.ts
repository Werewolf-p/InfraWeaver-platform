// Notification pipeline: fingerprint → dedup → group by app+cause → severity
// rank → per-app rate-limit (overflow fold) → collapse. Kills storms at the
// source so a flapping pod is ONE grouped notification, not twenty rows.

import { fingerprint } from "./fingerprint";
import type {
  BuildNotificationsOptions,
  GroupedNotification,
  NotificationLevel,
  NotificationSeverity,
  RawSignal,
} from "./types";

const DEFAULT_MAX_PER_APP = 5;
const DEFAULT_MAX_TOTAL = 20;
const DEFAULT_FLAP_ESCALATION = 5;

const LEVEL_RANK: Record<NotificationLevel, number> = { success: 0, info: 1, warning: 2, error: 3 };
const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, notice: 1, warning: 2, critical: 3 };

function higherLevel(a: NotificationLevel, b: NotificationLevel): NotificationLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * Rank severity from the collapsed level and repeat count. A warning that has
 * flapped `flapEscalationCount`+ times is escalated to critical.
 */
export function deriveNotificationSeverity(
  level: NotificationLevel,
  count: number,
  flapEscalationCount: number,
): NotificationSeverity {
  if (level === "error") return "critical";
  if (level === "warning") return count >= flapEscalationCount ? "critical" : "warning";
  if (level === "success") return "notice";
  return "info";
}

/** Compare by severity (desc) then recency (desc). */
function bySeverityThenRecency(a: GroupedNotification, b: GroupedNotification): number {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  return severity !== 0 ? severity : b.lastSeen - a.lastSeen;
}

function foldSignalsByFingerprint(signals: RawSignal[], flapEscalationCount: number): GroupedNotification[] {
  const groups = new Map<string, GroupedNotification>();

  for (const signal of signals) {
    const fp = fingerprint(signal);
    const existing = groups.get(fp);

    if (!existing) {
      groups.set(fp, {
        id: `grp:${fp}`,
        app: signal.app,
        cause: signal.cause,
        title: signal.title,
        body: signal.body,
        level: signal.level,
        severity: deriveNotificationSeverity(signal.level, 1, flapEscalationCount),
        firstSeen: signal.timestamp,
        lastSeen: signal.timestamp,
        count: 1,
        fingerprint: fp,
        timestamp: signal.timestamp,
        read: false,
      });
      continue;
    }

    const count = existing.count + 1;
    const level = higherLevel(existing.level, signal.level);
    const isNewer = signal.timestamp >= existing.lastSeen;
    groups.set(fp, {
      ...existing,
      count,
      level,
      severity: deriveNotificationSeverity(level, count, flapEscalationCount),
      firstSeen: Math.min(existing.firstSeen, signal.timestamp),
      lastSeen: Math.max(existing.lastSeen, signal.timestamp),
      timestamp: Math.max(existing.lastSeen, signal.timestamp),
      // Keep the most recent title/body so the collapsed row shows the latest.
      title: isNewer ? signal.title : existing.title,
      body: isNewer ? signal.body : existing.body,
    });
  }

  return [...groups.values()];
}

/** Cap groups per app, folding the overflow into one "N more from <app>" row. */
function applyPerAppLimit(groups: GroupedNotification[], maxPerApp: number): GroupedNotification[] {
  const byApp = new Map<string, GroupedNotification[]>();
  for (const group of groups) {
    const app = group.app ?? "cluster";
    const list = byApp.get(app) ?? [];
    list.push(group);
    byApp.set(app, list);
  }

  const result: GroupedNotification[] = [];
  for (const [app, list] of byApp) {
    const sorted = [...list].sort(bySeverityThenRecency);
    const kept = sorted.slice(0, maxPerApp);
    const overflow = sorted.slice(maxPerApp);
    result.push(...kept);

    if (overflow.length === 0) continue;

    const overflowCount = overflow.reduce((sum, group) => sum + group.count, 0);
    const level = overflow.reduce<NotificationLevel>((max, group) => higherLevel(max, group.level), "info");
    result.push({
      id: `grp:overflow:${app}`,
      app,
      cause: "multiple",
      title: `${overflow.length} more issues from ${app}`,
      body: `${overflowCount} additional events collapsed`,
      level,
      severity: deriveNotificationSeverity(level, overflowCount, Number.MAX_SAFE_INTEGER),
      firstSeen: Math.min(...overflow.map((group) => group.firstSeen)),
      lastSeen: Math.max(...overflow.map((group) => group.lastSeen)),
      timestamp: Math.max(...overflow.map((group) => group.lastSeen)),
      count: overflow.length,
      fingerprint: `overflow:${app}`,
      read: false,
      overflow: true,
    });
  }

  return result;
}

/**
 * Collapse raw signals into grouped, severity-ranked notifications.
 * This is the pipeline entry point consumed by /api/notifications.
 */
export function buildNotifications(
  signals: RawSignal[],
  options: BuildNotificationsOptions = {},
): GroupedNotification[] {
  const maxPerApp = options.maxPerApp ?? DEFAULT_MAX_PER_APP;
  const maxTotal = options.maxTotal ?? DEFAULT_MAX_TOTAL;
  const flapEscalationCount = options.flapEscalationCount ?? DEFAULT_FLAP_ESCALATION;

  const grouped = foldSignalsByFingerprint(signals, flapEscalationCount);
  const limited = applyPerAppLimit(grouped, maxPerApp);
  return limited.sort(bySeverityThenRecency).slice(0, maxTotal);
}
