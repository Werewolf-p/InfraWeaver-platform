/** @jest-environment node */
// Pure Insights lib: the zod param validators (parity with the connector's
// validate_* methods) and the framework-free state/format helpers that drive the
// honest locked / upsell / connector-too-old / ready states. No numbers are ever
// fabricated — a locked response renders its real gate reason, nothing else.

import {
  ACTIVITY_LIMIT_MAX,
  DEFAULT_STATS_RANGE,
  SERIES_DAYS_MAX,
  activityLogParamsSchema,
  statsSummaryParamsSchema,
  statsTimeseriesParamsSchema,
  type StatsSummaryResponse,
} from "@/addons/wordpress-manager/lib/manage/insights";
import {
  INSIGHTS_TIER_LABEL,
  compactNumber,
  deriveInsightsView,
  gateReasonText,
  isConnectorTooOld,
  primaryGateReason,
  privacySignals,
  roundDelta,
} from "@/addons/wordpress-manager/lib/manage/insights-format";

describe("insights param schemas (parity with connector validators)", () => {
  test("stats.summary accepts empty + the three allowed ranges, rejects others", () => {
    expect(statsSummaryParamsSchema.safeParse({}).success).toBe(true);
    for (const r of [1, 7, 30]) expect(statsSummaryParamsSchema.safeParse({ range_days: r }).success).toBe(true);
    expect(statsSummaryParamsSchema.safeParse({ range_days: 3 }).success).toBe(false);
    expect(statsSummaryParamsSchema.safeParse({ range_days: 90 }).success).toBe(false);
    // Strict: no stray keys.
    expect(statsSummaryParamsSchema.safeParse({ range_days: 7, extra: 1 }).success).toBe(false);
    expect(DEFAULT_STATS_RANGE).toBe(7);
  });

  test("stats.timeseries accepts empty + 1..30, rejects 0, 31 and non-ints", () => {
    expect(statsTimeseriesParamsSchema.safeParse({}).success).toBe(true);
    expect(statsTimeseriesParamsSchema.safeParse({ days: 1 }).success).toBe(true);
    expect(statsTimeseriesParamsSchema.safeParse({ days: SERIES_DAYS_MAX }).success).toBe(true);
    expect(statsTimeseriesParamsSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(statsTimeseriesParamsSchema.safeParse({ days: 31 }).success).toBe(false);
    expect(statsTimeseriesParamsSchema.safeParse({ days: 2.5 }).success).toBe(false);
  });

  test("activity.log accepts empty + 1..100, rejects 0 and 101", () => {
    expect(activityLogParamsSchema.safeParse({}).success).toBe(true);
    expect(activityLogParamsSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(activityLogParamsSchema.safeParse({ limit: ACTIVITY_LIMIT_MAX }).success).toBe(true);
    expect(activityLogParamsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(activityLogParamsSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe("gate reason translation (honest S9 states)", () => {
  test("each known reason maps to distinct plain language", () => {
    expect(gateReasonText("requires-plus")).toContain(INSIGHTS_TIER_LABEL);
    expect(gateReasonText("not-linked")).toMatch(/link/i);
    expect(gateReasonText("heartbeat-stale")).toMatch(/check in|signed contact/i);
    expect(gateReasonText("mystery")).toMatch(/locked/i);
  });

  test("requires-plus wins as the primary reason and flags an upsell", () => {
    const r = primaryGateReason({ reasons: ["heartbeat-stale", "requires-plus"] });
    expect(r.upsell).toBe(true);
    expect(r.text).toContain(INSIGHTS_TIER_LABEL);
  });

  test("a non-tier reason is the primary and is not an upsell", () => {
    const r = primaryGateReason({ reasons: ["heartbeat-stale"] });
    expect(r.upsell).toBe(false);
    expect(r.text).toMatch(/check in|signed contact/i);
  });

  test("an absent gate degrades to a generic locked message", () => {
    expect(primaryGateReason(undefined).text).toMatch(/locked/i);
  });
});

describe("deriveInsightsView", () => {
  const ready: StatsSummaryResponse = { locked: false, range_days: 7, kpi: undefined };
  const locked: StatsSummaryResponse = { locked: true, gate: { reasons: ["requires-plus"] } };

  test("loading when no data/error", () => {
    expect(deriveInsightsView({ isLoading: true }).kind).toBe("loading");
  });

  test("501 error → connector too old", () => {
    const v = deriveInsightsView({ isLoading: false, error: { status: 501, message: "old" } });
    expect(v.kind).toBe("too-old");
  });

  test("other error → retryable error with message", () => {
    const v = deriveInsightsView({ isLoading: false, error: { status: 502, message: "boom" } });
    expect(v).toEqual({ kind: "error", message: "boom" });
  });

  test("locked response → locked view carrying the real reason (never numbers)", () => {
    const v = deriveInsightsView({ isLoading: false, data: locked });
    expect(v.kind).toBe("locked");
    if (v.kind === "locked") {
      expect(v.upsell).toBe(true);
      expect(v.reason).toContain(INSIGHTS_TIER_LABEL);
      expect(v.tier).toBe(INSIGHTS_TIER_LABEL);
    }
  });

  test("unlocked response → ready with the data", () => {
    const v = deriveInsightsView({ isLoading: false, data: ready });
    expect(v.kind).toBe("ready");
    if (v.kind === "ready") expect(v.data).toBe(ready);
  });

  test("error wins over stale data", () => {
    const v = deriveInsightsView({ isLoading: false, data: ready, error: { status: 500, message: "x" } });
    expect(v.kind).toBe("error");
  });
});

describe("format helpers", () => {
  test("isConnectorTooOld only matches a 501 status carrier", () => {
    expect(isConnectorTooOld({ status: 501 })).toBe(true);
    expect(isConnectorTooOld({ status: 502 })).toBe(false);
    expect(isConnectorTooOld(new Error("x"))).toBe(false);
    expect(isConnectorTooOld(null)).toBe(false);
  });

  test("compactNumber abbreviates thousands/millions", () => {
    expect(compactNumber(950)).toBe("950");
    expect(compactNumber(1500)).toBe("1.5k");
    expect(compactNumber(2_000)).toBe("2k");
    expect(compactNumber(2_500_000)).toBe("2.5M");
  });

  test("roundDelta rounds, passes null through for absent baselines", () => {
    expect(roundDelta(12.4)).toBe(12);
    expect(roundDelta(-8.9)).toBe(-9);
    expect(roundDelta(null)).toBeNull();
    expect(roundDelta(undefined)).toBeNull();
  });

  test("privacySignals lists only the active signals, consent only when gated", () => {
    expect(privacySignals({ dnt: 1, gpc: 1, consent_gated: 0 })).toEqual(["DNT", "GPC"]);
    expect(privacySignals({ dnt: 1, gpc: 1, consent_gated: 1 })).toEqual(["DNT", "GPC", "consent banner"]);
    expect(privacySignals(undefined)).toEqual([]);
  });
});
