// Notification pipeline types. Pure — shared by the server route, the pipeline,
// and (type-only) the client hook.

export type NotificationLevel = "info" | "warning" | "error" | "success";

/** Ranked severity used for ordering + colouring in the bell. */
export type NotificationSeverity = "info" | "notice" | "warning" | "critical";

/**
 * A single raw signal (typically a K8s Warning event) before dedup/grouping.
 */
export interface RawSignal {
  /** Source id (e.g. the K8s event id). Only used for traceability. */
  key: string;
  /** Owning app label (namespace is the authoritative grouping unit). */
  app?: string;
  /** Cause bucket — the K8s reason (e.g. "BackOff", "Unhealthy"). */
  cause: string;
  /** Raw reason (kept distinct from a normalized cause for fingerprinting). */
  reason?: string;
  /** `Kind/name` of the involved object. */
  object?: string;
  namespace?: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  timestamp: number;
}

/**
 * A collapsed notification: many identical/flapping signals folded into one
 * entry with a `count` and a first/last-seen window.
 */
export interface GroupedNotification {
  id: string;
  app?: string;
  cause: string;
  title: string;
  body?: string;
  level: NotificationLevel;
  severity: NotificationSeverity;
  firstSeen: number;
  lastSeen: number;
  count: number;
  fingerprint: string;
  /** Alias of `lastSeen` so existing bell clients that read `timestamp` work. */
  timestamp: number;
  read: boolean;
  /** True for the synthetic "N more from <app>" overflow row. */
  overflow?: boolean;
}

export interface BuildNotificationsOptions {
  /** Max distinct groups surfaced per app before overflow folding. */
  maxPerApp?: number;
  /** Max total notifications returned. */
  maxTotal?: number;
  /** Repeat count at/above which a warning group escalates to critical. */
  flapEscalationCount?: number;
}
