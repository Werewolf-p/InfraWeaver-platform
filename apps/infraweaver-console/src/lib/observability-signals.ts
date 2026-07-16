/**
 * Shared, CLIENT-SAFE observability signal model for the "what breaks next"
 * board (Subject 2). Pure classifiers turn each raw platform payload into a
 * normalized {@link Signal}; every "alert before outage" threshold lives here as
 * a NAMED CONSTANT so the UI board and any notifier (Subject 3) classify from the
 * SAME numbers and never drift.
 *
 * This module MUST stay free of `server-only`, Kubernetes clients, and `fetch`
 * so it can be unit-tested and imported by client widgets alike. It consumes
 * Subject 5's already-computed secret severity via {@link SecretLifecycleReport}
 * — it never re-derives token/ESO/seal health.
 */

import { nextCronRuns } from "@/lib/cron-utils";
import type { ArgoAppSummary } from "@/lib/argocd-apps";
import type { CronJobItem } from "@/lib/ops-data";
import type { SecretLifecycleReport } from "@/lib/secrets/lifecycle-types";

export type Severity = "ok" | "warn" | "critical";

export type SignalSource = "argocd" | "secrets" | "resources" | "cron" | "posture" | "reliability";

export interface Signal {
  /** Stable per-source id (one rolled-up signal per domain). */
  id: string;
  source: SignalSource;
  label: string;
  severity: Severity;
  /** Short, glanceable summary of the worst state. */
  headline: string;
  /** Longer "why" line naming the top offenders. */
  detail: string;
  /** Optional compact metric, e.g. "3 / 42". */
  metric?: string;
  /** Deep-link to the owning detail page. */
  href: string;
}

// ── Thresholds — the "alert before outage" definitions (no magic numbers) ─────

/** Secret/cert expiry bands (days of remaining validity). */
export const SECRET_EXPIRY_WARN_DAYS = 30;
export const SECRET_EXPIRY_CRITICAL_DAYS = 14;
export const SECRET_EXPIRY_URGENT_DAYS = 7;

/** OpenBao period-8760h token — a dead token takes 24 ExternalSecrets down. */
export const OPENBAO_TOKEN_WARN_DAYS = 30;
export const OPENBAO_TOKEN_CRITICAL_DAYS = 7;

/** Cron drift: `now - lastSchedule > interval × factor` ⇒ overdue. */
export const CRON_OVERDUE_FACTOR = 1.5;
export const CRON_OVERDUE_CRITICAL_FACTOR = 3;
/** Slack past a computed `nextRun` before a never-run cron counts as overdue. */
export const CRON_GRACE_MS = 5 * 60_000;

/** Any OutOfSync app = warn; any Degraded/Missing/Failed = critical. */
export const ARGO_OUTOFSYNC_WARN = 1;

/** Security posture score bands (grade < B ⇒ warn, well below ⇒ critical). */
export const POSTURE_SCORE_WARN = 80;
export const POSTURE_SCORE_CRITICAL = 70;

/** OOMKills counted inside this rolling window predict the next crashloop. */
export const OOM_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
export const OOM_COUNT_WARN = 1;
export const OOM_COUNT_CRITICAL = 3;

/** Node memory headroom — percentage of allocatable in use. */
export const MEM_PRESSURE_WARN_PCT = 80;
export const MEM_PRESSURE_CRITICAL_PCT = 90;

/** Any node not Ready is a critical resource signal. */
export const NODE_NOTREADY_CRITICAL = 1;

/** Reliability composite score bands (one number for "is the platform ok"). */
export const RELIABILITY_SCORE_WARN = 90;
export const RELIABILITY_SCORE_CRITICAL = 75;

// ── Deep-link + label maps ────────────────────────────────────────────────────

export const SIGNAL_HREF: Record<SignalSource, string> = {
  argocd: "/gitops-diff",
  secrets: "/secret-health",
  resources: "/node-top",
  cron: "/cronjobs",
  posture: "/security",
  reliability: "/monitoring?tab=health",
};

export const SOURCE_LABEL: Record<SignalSource, string> = {
  argocd: "ArgoCD Sync",
  secrets: "Secret & Cert Health",
  resources: "Resource Pressure",
  cron: "Cron Health",
  posture: "Security Posture",
  reliability: "Reliability",
};

// ── Severity helpers ──────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1, ok: 2 };

/** The more severe of two severities. */
export function worseSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/** The worst severity across a list; `ok` when empty. */
export function maxSeverity(severities: readonly Severity[]): Severity {
  return severities.reduce<Severity>((worst, current) => worseSeverity(worst, current), "ok");
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ── ArgoCD ────────────────────────────────────────────────────────────────────

/** OutOfSync ⇒ warn, Degraded/Missing/Failed ⇒ critical (before selfHeal cascades). */
export function classifyArgo(summary: ArgoAppSummary): Signal {
  const severity: Severity = summary.issues > 0
    ? "critical"
    : summary.outOfSync >= ARGO_OUTOFSYNC_WARN
      ? "warn"
      : "ok";

  const headline = summary.issues > 0
    ? `${plural(summary.issues, "app")} Degraded or Missing`
    : summary.outOfSync > 0
      ? `${plural(summary.outOfSync, "app")} OutOfSync`
      : "All apps Synced & Healthy";

  return {
    id: "argocd",
    source: "argocd",
    label: SOURCE_LABEL.argocd,
    severity,
    headline,
    detail: `${summary.healthy}/${summary.total} healthy · ${summary.degraded} degraded · ${summary.outOfSync} out of sync`,
    metric: `${summary.healthy}/${summary.total}`,
    href: SIGNAL_HREF.argocd,
  };
}

// ── Secrets & certs (consumes Subject 5's computed severity) ───────────────────

/** Maps Subject 5's lifecycle report to a board signal. Does NOT re-derive health. */
export function classifySecrets(report: SecretLifecycleReport): Signal {
  const ttlDays = report.token.available && report.token.ttlSeconds !== null
    ? Math.floor(report.token.ttlSeconds / 86_400)
    : null;
  const notReady = report.externalSecrets.notReady;
  const retainTraps = report.externalSecrets.retainTraps;

  const headline = report.openbao.available && report.openbao.sealed
    ? "OpenBao is sealed"
    : retainTraps > 0
      ? `${plural(retainTraps, "Retain trap")}`
      : notReady > 0
        ? `${plural(notReady, "ExternalSecret")} not Ready`
        : ttlDays !== null && ttlDays <= OPENBAO_TOKEN_WARN_DAYS
          ? `OpenBao token TTL ${ttlDays}d`
          : "Secrets healthy";

  return {
    id: "secrets",
    source: "secrets",
    label: SOURCE_LABEL.secrets,
    severity: report.severity,
    headline,
    detail: `${notReady} ES not-ready · ${retainTraps} Retain traps · ${report.catalogCoverage.totalMissing} missing keys`,
    metric: ttlDays === null ? undefined : `${ttlDays}d TTL`,
    href: SIGNAL_HREF.secrets,
  };
}

// ── Cron health (overdue + wedged detection) ──────────────────────────────────

function isForbidPolicy(cron: CronJobItem): boolean {
  return (cron.concurrencyPolicy ?? "").trim().toLowerCase() === "forbid";
}

/** Milliseconds between two consecutive fires of a schedule, anchored at `anchorMs`. */
export function cronIntervalMs(schedule: string, anchorMs: number): number | null {
  const runs = nextCronRuns(schedule, 2, new Date(anchorMs));
  if (runs.length < 2) return null;
  return runs[1].getTime() - runs[0].getTime();
}

/**
 * Overdue level from schedule drift. `critical` past ×3 the interval, `warn`
 * past ×1.5. Suspended jobs are never overdue. Falls back to a `nextRun` grace
 * window when the job has never fired.
 */
export function cronOverdueLevel(cron: CronJobItem, now: number): Severity {
  if (cron.suspended) return "ok";

  const lastMs = parseMs(cron.lastSchedule);
  if (lastMs === null) {
    const nextMs = parseMs(cron.nextRun);
    return nextMs !== null && now > nextMs + CRON_GRACE_MS ? "warn" : "ok";
  }

  const intervalMs = cronIntervalMs(cron.schedule, lastMs);
  if (intervalMs === null || intervalMs <= 0) return "ok";

  const ratio = (now - lastMs) / intervalMs;
  if (ratio > CRON_OVERDUE_CRITICAL_FACTOR) return "critical";
  if (ratio > CRON_OVERDUE_FACTOR) return "warn";
  return "ok";
}

export function isCronOverdue(cron: CronJobItem, now: number): boolean {
  return cronOverdueLevel(cron, now) !== "ok";
}

/**
 * The WP health-sweep trap: `concurrencyPolicy: Forbid` + a running pod that
 * never completes blocks every future fire, so the job silently goes stale.
 */
export function isCronWedged(cron: CronJobItem, now: number): boolean {
  return isForbidPolicy(cron) && cron.active > 0 && isCronOverdue(cron, now);
}

export function classifyCron(cronjobs: readonly CronJobItem[], now: number): Signal {
  const wedged = cronjobs.filter((cron) => isCronWedged(cron, now));
  const overdueCritical = cronjobs.filter((cron) => !isCronWedged(cron, now) && cronOverdueLevel(cron, now) === "critical");
  const overdueWarn = cronjobs.filter((cron) => cronOverdueLevel(cron, now) === "warn");
  const failing = cronjobs.filter((cron) => cron.failing);
  const suspended = cronjobs.filter((cron) => cron.suspended);

  const severity: Severity = wedged.length > 0 || overdueCritical.length > 0
    ? "critical"
    : overdueWarn.length > 0 || failing.length > 0 || suspended.length > 0
      ? "warn"
      : "ok";

  const headline = wedged.length > 0
    ? `${plural(wedged.length, "cron")} wedged (Forbid + stuck)`
    : overdueCritical.length > 0
      ? `${plural(overdueCritical.length, "cron")} badly overdue`
      : overdueWarn.length > 0
        ? `${plural(overdueWarn.length, "cron")} overdue`
        : failing.length > 0
          ? `${plural(failing.length, "cron")} failing`
          : suspended.length > 0
            ? `${plural(suspended.length, "cron")} suspended`
            : "All crons on schedule";

  const offender = wedged[0] ?? overdueCritical[0] ?? overdueWarn[0] ?? failing[0] ?? suspended[0] ?? null;
  const detail = offender
    ? `Top: ${offender.namespace}/${offender.name} · ${cronjobs.length} total`
    : `${cronjobs.length} cronjobs on schedule`;

  return {
    id: "cron",
    source: "cron",
    label: SOURCE_LABEL.cron,
    severity,
    headline,
    detail,
    metric: `${wedged.length + overdueCritical.length + overdueWarn.length}/${cronjobs.length}`,
    href: SIGNAL_HREF.cron,
  };
}

// ── Security posture ──────────────────────────────────────────────────────────

export interface PostureSignalInput {
  score: number;
  grade: string;
}

export function classifyPosture(posture: PostureSignalInput): Signal {
  const severity: Severity = posture.score < POSTURE_SCORE_CRITICAL
    ? "critical"
    : posture.score < POSTURE_SCORE_WARN
      ? "warn"
      : "ok";

  return {
    id: "posture",
    source: "posture",
    label: SOURCE_LABEL.posture,
    severity,
    headline: severity === "ok" ? `Grade ${posture.grade} · ${posture.score}` : `Posture dropped to grade ${posture.grade}`,
    detail: `Security posture score ${posture.score} (grade ${posture.grade}).`,
    metric: `${posture.score}`,
    href: SIGNAL_HREF.posture,
  };
}

// ── Resource pressure ─────────────────────────────────────────────────────────

export interface ResourceSignalInput {
  oomEvents: ReadonlyArray<{ timestamp: string | null }>;
  nodesNotReady: number;
  maxMemPressurePct: number;
}

export function classifyResource(input: ResourceSignalInput, now: number): Signal {
  const recentOom = input.oomEvents.filter((event) => {
    const ts = parseMs(event.timestamp);
    return ts !== null && now - ts <= OOM_RECENT_WINDOW_MS;
  }).length;

  const severity: Severity = recentOom >= OOM_COUNT_CRITICAL
    || input.nodesNotReady >= NODE_NOTREADY_CRITICAL
    || input.maxMemPressurePct >= MEM_PRESSURE_CRITICAL_PCT
    ? "critical"
    : recentOom >= OOM_COUNT_WARN || input.maxMemPressurePct >= MEM_PRESSURE_WARN_PCT
      ? "warn"
      : "ok";

  const headline = input.nodesNotReady >= NODE_NOTREADY_CRITICAL
    ? `${plural(input.nodesNotReady, "node")} NotReady`
    : recentOom >= OOM_COUNT_WARN
      ? `${plural(recentOom, "OOMKill")} in ${OOM_RECENT_WINDOW_MS / (60 * 60 * 1000)}h`
      : input.maxMemPressurePct >= MEM_PRESSURE_WARN_PCT
        ? `Memory pressure ${input.maxMemPressurePct}%`
        : "Resources healthy";

  return {
    id: "resources",
    source: "resources",
    label: SOURCE_LABEL.resources,
    severity,
    headline,
    detail: `${recentOom} recent OOMKills · ${input.nodesNotReady} nodes NotReady · peak mem ${input.maxMemPressurePct}%`,
    metric: `${input.maxMemPressurePct}%`,
    href: SIGNAL_HREF.resources,
  };
}

// ── Reliability composite ─────────────────────────────────────────────────────

export interface ReliabilitySignalInput {
  score: number;
  grade: string;
}

export function classifyReliability(reliability: ReliabilitySignalInput): Signal {
  const severity: Severity = reliability.score < RELIABILITY_SCORE_CRITICAL
    ? "critical"
    : reliability.score < RELIABILITY_SCORE_WARN
      ? "warn"
      : "ok";

  return {
    id: "reliability",
    source: "reliability",
    label: SOURCE_LABEL.reliability,
    severity,
    headline: severity === "ok" ? `Grade ${reliability.grade} · ${reliability.score}` : `Reliability grade ${reliability.grade}`,
    detail: `Composite reliability score ${reliability.score} (grade ${reliability.grade}).`,
    metric: `${reliability.score}`,
    href: SIGNAL_HREF.reliability,
  };
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

export interface AggregateSignalsInput {
  argo?: ArgoAppSummary | null;
  secrets?: SecretLifecycleReport | null;
  cron?: readonly CronJobItem[] | null;
  posture?: PostureSignalInput | null;
  resource?: ResourceSignalInput | null;
  reliability?: ReliabilitySignalInput | null;
  /** Injected for deterministic tests; defaults to `Date.now()`. */
  now?: number;
}

export interface SignalsSummary {
  signals: Signal[];
  worst: Severity;
  criticalCount: number;
  warnCount: number;
}

/**
 * Fan-in of every present domain input into one severity-sorted signal list.
 * Immutable: builds a new array, sorts a copy, never mutates inputs.
 */
export function aggregateSignals(input: AggregateSignalsInput): SignalsSummary {
  const now = input.now ?? Date.now();
  const signals: Signal[] = [];

  if (input.argo) signals.push(classifyArgo(input.argo));
  if (input.secrets) signals.push(classifySecrets(input.secrets));
  if (input.cron) signals.push(classifyCron(input.cron, now));
  if (input.posture) signals.push(classifyPosture(input.posture));
  if (input.resource) signals.push(classifyResource(input.resource, now));
  if (input.reliability) signals.push(classifyReliability(input.reliability));

  const sorted = [...signals].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return {
    signals: sorted,
    worst: maxSeverity(sorted.map((signal) => signal.severity)),
    criticalCount: sorted.filter((signal) => signal.severity === "critical").length,
    warnCount: sorted.filter((signal) => signal.severity === "warn").length,
  };
}
