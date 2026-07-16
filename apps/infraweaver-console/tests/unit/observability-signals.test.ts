import { describe, expect, it } from "@jest/globals";
import type { ArgoAppSummary } from "@/lib/argocd-apps";
import type { CronJobItem } from "@/lib/ops-data";
import type { SecretLifecycleReport, Severity as SecretSeverity } from "@/lib/secrets/lifecycle-types";
import {
  aggregateSignals,
  classifyArgo,
  classifyCron,
  classifyPosture,
  classifyReliability,
  classifyResource,
  classifySecrets,
  isCronWedged,
  cronOverdueLevel,
  MEM_PRESSURE_CRITICAL_PCT,
  MEM_PRESSURE_WARN_PCT,
  OOM_COUNT_CRITICAL,
  POSTURE_SCORE_CRITICAL,
  POSTURE_SCORE_WARN,
  RELIABILITY_SCORE_CRITICAL,
  RELIABILITY_SCORE_WARN,
  SIGNAL_HREF,
} from "@/lib/observability-signals";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const MINUTE_MS = 60_000;

function makeArgoSummary(overrides: Partial<ArgoAppSummary> = {}): ArgoAppSummary {
  return {
    degraded: 0,
    healthy: 42,
    issues: 0,
    outOfSync: 0,
    progressing: 0,
    status: "healthy",
    total: 42,
    ...overrides,
  };
}

function makeCron(overrides: Partial<CronJobItem> = {}): CronJobItem {
  return {
    id: "monitoring/wp-health-sweep",
    namespace: "monitoring",
    name: "wp-health-sweep",
    schedule: "*/5 * * * *",
    suspended: false,
    active: 0,
    image: "iw/health:latest",
    concurrencyPolicy: "Allow",
    lastSchedule: new Date(NOW - 2 * MINUTE_MS).toISOString(),
    nextRun: new Date(NOW + 3 * MINUTE_MS).toISOString(),
    lastSuccess: new Date(NOW - 2 * MINUTE_MS).toISOString(),
    lastFailure: null,
    failing: false,
    recentJobs: [],
    ...overrides,
  };
}

function makeSecretReport(severity: SecretSeverity, overrides: Partial<SecretLifecycleReport> = {}): SecretLifecycleReport {
  return {
    severity,
    generatedAt: new Date(NOW).toISOString(),
    remediationWriteEnabled: false,
    token: { available: true, ttlSeconds: 3 * 86_400, expireTime: null, renewable: true, policies: [] },
    openbao: { available: true, initialized: true, sealed: false, standby: false, version: "2.0" },
    externalSecrets: { available: true, items: [], total: 5, notReady: 2, retainTraps: 1 },
    catalogCoverage: { available: true, items: [], totalMissing: 3 },
    publicMirror: { available: false, workflowName: null, status: null, conclusion: null, updatedAt: null, htmlUrl: null },
    argoCorrelations: [],
    ...overrides,
  };
}

describe("classifyArgo", () => {
  it("returns warn when any app is OutOfSync but none are degraded", () => {
    // Arrange
    const summary = makeArgoSummary({ outOfSync: 2, healthy: 40, total: 42 });

    // Act
    const signal = classifyArgo(summary);

    // Assert
    expect(signal.severity).toBe("warn");
    expect(signal.href).toBe(SIGNAL_HREF.argocd);
  });

  it("returns critical when an app is Degraded or Missing", () => {
    // Arrange
    const summary = makeArgoSummary({ degraded: 1, issues: 1, healthy: 41, total: 42 });

    // Act
    const signal = classifyArgo(summary);

    // Assert
    expect(signal.severity).toBe("critical");
  });

  it("returns ok when everything is synced and healthy", () => {
    // Arrange
    const summary = makeArgoSummary();

    // Act
    const signal = classifyArgo(summary);

    // Assert
    expect(signal.severity).toBe("ok");
  });
});

describe("classifyCron wedge + overdue detection", () => {
  it("marks a Forbid job with a stuck pod and stale schedule as critical (WP health-sweep wedge)", () => {
    // Arrange
    const wedged = makeCron({
      concurrencyPolicy: "Forbid",
      active: 1,
      lastSchedule: new Date(NOW - 30 * MINUTE_MS).toISOString(),
    });

    // Act
    const signal = classifyCron([wedged], NOW);

    // Assert
    expect(signal.severity).toBe("critical");
    expect(signal.headline).toMatch(/wedged/i);
  });

  it("flags overdue when now - lastSchedule exceeds interval times the overdue factor", () => {
    // Arrange — every-5-min job last fired 40 minutes ago (8x interval > 3x critical factor)
    const overdue = makeCron({ lastSchedule: new Date(NOW - 40 * MINUTE_MS).toISOString() });

    // Act
    const level = cronOverdueLevel(overdue, NOW);

    // Assert
    expect(level).toBe("critical");
  });

  it("treats a suspended-but-scheduled job as warn, never overdue", () => {
    // Arrange
    const suspended = makeCron({ suspended: true, lastSchedule: new Date(NOW - 90 * MINUTE_MS).toISOString() });

    // Act
    const signal = classifyCron([suspended], NOW);

    // Assert
    expect(cronOverdueLevel(suspended, NOW)).toBe("ok");
    expect(signal.severity).toBe("warn");
  });

  it("returns ok for a job that fired within its interval", () => {
    // Arrange
    const healthy = makeCron();

    // Act
    const signal = classifyCron([healthy], NOW);

    // Assert
    expect(signal.severity).toBe("ok");
  });
});

describe("isCronWedged", () => {
  it("is true only when Forbid, overdue, and a pod is still active", () => {
    // Arrange
    const wedged = makeCron({ concurrencyPolicy: "Forbid", active: 1, lastSchedule: new Date(NOW - 30 * MINUTE_MS).toISOString() });

    // Act + Assert
    expect(isCronWedged(wedged, NOW)).toBe(true);
  });

  it("is false when the policy allows concurrency even if overdue with an active pod", () => {
    // Arrange
    const overdueAllow = makeCron({ concurrencyPolicy: "Allow", active: 1, lastSchedule: new Date(NOW - 30 * MINUTE_MS).toISOString() });

    // Act + Assert
    expect(isCronWedged(overdueAllow, NOW)).toBe(false);
  });

  it("is false for a Forbid job with no active pod", () => {
    // Arrange
    const forbidIdle = makeCron({ concurrencyPolicy: "Forbid", active: 0, lastSchedule: new Date(NOW - 30 * MINUTE_MS).toISOString() });

    // Act + Assert
    expect(isCronWedged(forbidIdle, NOW)).toBe(false);
  });
});

describe("classifySecrets", () => {
  it("passes through Subject 5's computed severity without re-deriving it", () => {
    // Arrange
    const report = makeSecretReport("critical");

    // Act
    const signal = classifySecrets(report);

    // Assert
    expect(signal.severity).toBe("critical");
    expect(signal.href).toBe(SIGNAL_HREF.secrets);
  });

  it("surfaces a Retain trap in the headline", () => {
    // Arrange
    const report = makeSecretReport("critical");

    // Act
    const signal = classifySecrets(report);

    // Assert
    expect(signal.headline).toMatch(/retain trap/i);
  });
});

describe("classifyPosture score bands", () => {
  it("returns ok at the warn boundary score", () => {
    // Arrange + Act
    const signal = classifyPosture({ score: POSTURE_SCORE_WARN, grade: "B" });

    // Assert
    expect(signal.severity).toBe("ok");
  });

  it("returns warn just below grade B", () => {
    // Arrange + Act
    const signal = classifyPosture({ score: POSTURE_SCORE_WARN - 1, grade: "C" });

    // Assert
    expect(signal.severity).toBe("warn");
  });

  it("returns critical below the critical threshold", () => {
    // Arrange + Act
    const signal = classifyPosture({ score: POSTURE_SCORE_CRITICAL - 1, grade: "F" });

    // Assert
    expect(signal.severity).toBe("critical");
  });
});

describe("classifyResource", () => {
  it("returns critical when OOMKills in the window reach the critical count", () => {
    // Arrange
    const oomEvents = Array.from({ length: OOM_COUNT_CRITICAL }, () => ({ timestamp: new Date(NOW - 60 * MINUTE_MS).toISOString() }));

    // Act
    const signal = classifyResource({ oomEvents, nodesNotReady: 0, maxMemPressurePct: 10 }, NOW);

    // Assert
    expect(signal.severity).toBe("critical");
  });

  it("returns critical when any node is NotReady", () => {
    // Arrange + Act
    const signal = classifyResource({ oomEvents: [], nodesNotReady: 1, maxMemPressurePct: 10 }, NOW);

    // Assert
    expect(signal.severity).toBe("critical");
  });

  it("returns critical when memory pressure reaches the critical percentage", () => {
    // Arrange + Act
    const signal = classifyResource({ oomEvents: [], nodesNotReady: 0, maxMemPressurePct: MEM_PRESSURE_CRITICAL_PCT }, NOW);

    // Assert
    expect(signal.severity).toBe("critical");
  });

  it("returns warn at the memory pressure warn band", () => {
    // Arrange + Act
    const signal = classifyResource({ oomEvents: [], nodesNotReady: 0, maxMemPressurePct: MEM_PRESSURE_WARN_PCT }, NOW);

    // Assert
    expect(signal.severity).toBe("warn");
  });

  it("ignores OOMKills older than the recent window", () => {
    // Arrange — an OOM 12h ago is outside the 6h window
    const oomEvents = [{ timestamp: new Date(NOW - 12 * 60 * MINUTE_MS).toISOString() }];

    // Act
    const signal = classifyResource({ oomEvents, nodesNotReady: 0, maxMemPressurePct: 10 }, NOW);

    // Assert
    expect(signal.severity).toBe("ok");
  });
});

describe("classifyReliability score bands", () => {
  it("returns ok at the warn boundary", () => {
    expect(classifyReliability({ score: RELIABILITY_SCORE_WARN, grade: "A" }).severity).toBe("ok");
  });

  it("returns warn below the warn threshold", () => {
    expect(classifyReliability({ score: RELIABILITY_SCORE_WARN - 1, grade: "B" }).severity).toBe("warn");
  });

  it("returns critical below the critical threshold", () => {
    expect(classifyReliability({ score: RELIABILITY_SCORE_CRITICAL - 1, grade: "F" }).severity).toBe("critical");
  });
});

describe("aggregateSignals", () => {
  it("sorts signals critical then warn then ok and reports worst plus counts", () => {
    // Arrange
    const input = {
      argo: makeArgoSummary({ degraded: 1, issues: 1 }), // critical
      posture: { score: POSTURE_SCORE_WARN - 1, grade: "C" }, // warn
      reliability: { score: 99, grade: "A" }, // ok
      now: NOW,
    };

    // Act
    const result = aggregateSignals(input);

    // Assert
    expect(result.signals.map((signal) => signal.severity)).toEqual(["critical", "warn", "ok"]);
    expect(result.worst).toBe("critical");
    expect(result.criticalCount).toBe(1);
    expect(result.warnCount).toBe(1);
  });

  it("only emits signals for the domains whose inputs are present", () => {
    // Arrange
    const input = { argo: makeArgoSummary(), now: NOW };

    // Act
    const result = aggregateSignals(input);

    // Assert
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].source).toBe("argocd");
  });

  it("does not mutate the caller's cron input array", () => {
    // Arrange
    const cronjobs = [
      makeCron({ id: "a", lastSchedule: new Date(NOW - 40 * MINUTE_MS).toISOString() }),
      makeCron({ id: "b" }),
    ];
    const originalOrder = cronjobs.map((cron) => cron.id);

    // Act
    aggregateSignals({ cron: cronjobs, now: NOW });

    // Assert
    expect(cronjobs.map((cron) => cron.id)).toEqual(originalOrder);
  });

  it("reports ok worst severity when no inputs are provided", () => {
    // Arrange + Act
    const result = aggregateSignals({ now: NOW });

    // Assert
    expect(result.worst).toBe("ok");
    expect(result.signals).toHaveLength(0);
  });
});
