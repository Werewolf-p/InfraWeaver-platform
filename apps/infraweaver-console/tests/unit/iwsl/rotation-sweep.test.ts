/** @jest-environment node */
/**
 * §8 automated key-reroll sweep. The safety of auto-rotating live signing keys
 * rests entirely on WHICH links get selected, so these tests pin the eligibility
 * rules: age gating, skip suspended/pending/non-managed, resume-first ordering,
 * and the per-run cap that bounds blast radius.
 */
jest.mock("server-only", () => ({}), { virtual: true });

const mockRotate = jest.fn();
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  rotateConnectorKey: mockRotate,
}));

const mockListExternalSites = jest.fn();
jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({
  listExternalSites: mockListExternalSites,
}));

import {
  keyAgeMs,
  selectRotationCandidates,
  runRotationSweep,
  effectiveMaxAgeMs,
} from "@/addons/wordpress-manager/lib/rotation-sweep";
import type { ExternalSiteRecord } from "@/addons/wordpress-manager/lib/iwsl-link-store";

const NOW = Date.parse("2026-07-18T00:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

function rec(over: Partial<ExternalSiteRecord> & { siteId: string }): ExternalSiteRecord {
  return {
    siteId: over.siteId,
    name: over.siteId,
    url: `https://${over.siteId}.example.com`,
    state: "active",
    fingerprintConfirmed: true,
    createdAt: daysAgo(60),
    createdBy: "test",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
    managed: true,
    siteName: over.siteId,
    activatedAt: daysAgo(60),
    ...over,
  };
}

const names = (cs: Array<{ siteName: string }>): string[] => cs.map((c) => c.siteName);

describe("keyAgeMs", () => {
  test("anchors on lastReroll.at when present (takes precedence over activatedAt)", () => {
    const site = rec({ siteId: "a", activatedAt: daysAgo(90), lastReroll: { at: daysAgo(5), outcome: "confirmed", kid: 2 } });
    expect(keyAgeMs(site, NOW)).toBe(5 * DAY);
  });

  test("falls back to activatedAt when never rerolled", () => {
    expect(keyAgeMs(rec({ siteId: "a", activatedAt: daysAgo(12) }), NOW)).toBe(12 * DAY);
  });

  test("treats a record with no usable anchor as maximally old", () => {
    const site = rec({ siteId: "a", activatedAt: undefined, lastReroll: undefined });
    expect(keyAgeMs(site, NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("selectRotationCandidates", () => {
  const opts = { now: NOW, maxAgeMs: 30 * DAY, maxPerRun: 10 };

  test("selects only keys past the age threshold, oldest first", () => {
    const sites = [
      rec({ siteId: "young", activatedAt: daysAgo(10) }),
      rec({ siteId: "old40", activatedAt: daysAgo(40) }),
      rec({ siteId: "old35byReroll", activatedAt: daysAgo(90), lastReroll: { at: daysAgo(35), outcome: "confirmed", kid: 2 } }),
    ];
    expect(names(selectRotationCandidates(sites, opts))).toEqual(["old40", "old35byReroll"]);
  });

  test("skips suspended, non-managed, and non-active links even when old", () => {
    const sites = [
      rec({ siteId: "suspended", activatedAt: daysAgo(50), identitySuspended: true }),
      rec({ siteId: "external", activatedAt: daysAgo(50), managed: false, siteName: undefined }),
      rec({ siteId: "pendingState", activatedAt: daysAgo(50), state: "pending" }),
      rec({ siteId: "quarantined", activatedAt: daysAgo(50), state: "quarantined" }),
      rec({ siteId: "unconfirmed", activatedAt: daysAgo(50), fingerprintConfirmed: false }),
    ];
    expect(selectRotationCandidates(sites, opts)).toEqual([]);
  });

  test("always resumes an in-flight rotation and orders it first, even if young", () => {
    const sites = [
      rec({ siteId: "old40", activatedAt: daysAgo(40) }),
      rec({
        siteId: "youngPending",
        activatedAt: daysAgo(3),
        pendingRotation: { rotationId: "r", newKid: 2, newWpPk: null, phase: "prepare", startedTs: NOW, deadlineTs: NOW },
      }),
    ];
    const out = selectRotationCandidates(sites, opts);
    expect(names(out)).toEqual(["youngPending", "old40"]);
    expect(out[0].resuming).toBe(true);
  });

  test("caps at maxPerRun, keeping the highest-priority entries", () => {
    const sites = [
      rec({ siteId: "old40", activatedAt: daysAgo(40) }),
      rec({ siteId: "old50", activatedAt: daysAgo(50) }),
      rec({ siteId: "old35", activatedAt: daysAgo(35) }),
    ];
    expect(names(selectRotationCandidates(sites, { ...opts, maxPerRun: 2 }))).toEqual(["old50", "old40"]);
  });

  test("nothing eligible → empty (fresh fleet doesn't rotate the day it deploys)", () => {
    const sites = [rec({ siteId: "a", activatedAt: daysAgo(1) }), rec({ siteId: "b", activatedAt: daysAgo(0) })];
    expect(selectRotationCandidates(sites, opts)).toEqual([]);
  });
});

describe("runRotationSweep", () => {
  beforeEach(() => {
    mockRotate.mockReset();
    mockListExternalSites.mockReset();
    delete process.env.IWSL_ROTATION_MAX_AGE_DAYS;
    delete process.env.IWSL_ROTATION_MAX_PER_RUN;
  });

  test("rotates the eligible (capped) set and summarizes outcomes", async () => {
    mockListExternalSites.mockResolvedValue([
      rec({ siteId: "old40", activatedAt: daysAgo(40) }),
      rec({ siteId: "young", activatedAt: daysAgo(2) }),
      rec({ siteId: "old50", activatedAt: daysAgo(50) }),
    ]);
    mockRotate.mockImplementation(async (siteName: string) => ({
      outcome: "confirmed",
      kid: 2,
      wpFingerprint: `fp-${siteName}`,
    }));

    const summary = await runRotationSweep(NOW);

    // Default maxPerRun=2 → the two oldest, in age order.
    expect(mockRotate).toHaveBeenCalledTimes(2);
    expect(mockRotate.mock.calls.map((c) => c[0])).toEqual(["old50", "old40"]);
    expect(summary.scanned).toBe(3);
    expect(summary.attempted).toBe(2);
    expect(summary.rotated).toBe(2);
    expect(summary.results.every((r) => r.outcome === "confirmed")).toBe(true);
  });

  test("L1: a huge maxPerRun env cannot exceed the hard ceiling", async () => {
    process.env.IWSL_ROTATION_MAX_PER_RUN = "100000";
    mockListExternalSites.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => rec({ siteId: `old${i}`, activatedAt: daysAgo(40) })),
    );
    mockRotate.mockResolvedValue({ outcome: "confirmed", kid: 2, wpFingerprint: "x" });

    const summary = await runRotationSweep(NOW);

    // HARD_MAX_PER_RUN caps the blast radius regardless of the env override.
    expect(summary.attempted).toBe(10);
    expect(mockRotate).toHaveBeenCalledTimes(10);
  });

  test("a rotation that throws is captured as an error result, not a rejection", async () => {
    mockListExternalSites.mockResolvedValue([rec({ siteId: "old40", activatedAt: daysAgo(40) })]);
    mockRotate.mockRejectedValue(new Error("pod not running"));

    const summary = await runRotationSweep(NOW);

    expect(summary.attempted).toBe(1);
    expect(summary.rotated).toBe(0);
    expect(summary.results[0]).toMatchObject({ site: "old40", outcome: "error", error: "pod not running" });
  });
});

describe("per-site rotation policy (effectiveMaxAgeMs + selection)", () => {
  const DEFAULT = 30 * DAY;
  const HOUR = 3_600_000;

  test("effectiveMaxAgeMs falls back to the fleet default when no policy is set", () => {
    expect(effectiveMaxAgeMs(rec({ siteId: "a" }), DEFAULT)).toBe(DEFAULT);
  });

  test("effectiveMaxAgeMs uses the per-site interval when present", () => {
    const s = rec({ siteId: "a", rotationPolicy: { autoRotate: true, intervalMs: 7 * DAY } });
    expect(effectiveMaxAgeMs(s, DEFAULT)).toBe(7 * DAY);
  });

  test("effectiveMaxAgeMs clamps an out-of-range per-site interval (floor 1h, ceil 1y)", () => {
    expect(effectiveMaxAgeMs(rec({ siteId: "a", rotationPolicy: { autoRotate: true, intervalMs: 1000 } }), DEFAULT)).toBe(HOUR);
    expect(effectiveMaxAgeMs(rec({ siteId: "a", rotationPolicy: { autoRotate: true, intervalMs: 10 * 365 * DAY } }), DEFAULT)).toBe(365 * DAY);
  });

  test("a shorter per-site interval makes a key that is younger than the default eligible", () => {
    // 10-day-old key: not eligible under the 30d default, eligible under a 7d override.
    const site = rec({ siteId: "custom", activatedAt: daysAgo(10), rotationPolicy: { autoRotate: true, intervalMs: 7 * DAY } });
    const picked = selectRotationCandidates([site], { now: NOW, maxAgeMs: DEFAULT, maxPerRun: 5 });
    expect(names(picked)).toEqual(["custom"]);
  });

  test("a longer per-site interval keeps an otherwise-overdue key ineligible", () => {
    // 40-day-old key would roll under the 30d default; a 90d override holds it.
    const site = rec({ siteId: "slow", activatedAt: daysAgo(40), rotationPolicy: { autoRotate: true, intervalMs: 90 * DAY } });
    const picked = selectRotationCandidates([site], { now: NOW, maxAgeMs: DEFAULT, maxPerRun: 5 });
    expect(picked).toHaveLength(0);
  });

  test("autoRotate:false excludes an overdue key from scheduled rotation", () => {
    const site = rec({ siteId: "manual", activatedAt: daysAgo(365), rotationPolicy: { autoRotate: false } });
    const picked = selectRotationCandidates([site], { now: NOW, maxAgeMs: DEFAULT, maxPerRun: 5 });
    expect(picked).toHaveLength(0);
  });

  test("autoRotate:false still RESUMES an in-flight rotation (safety: finish what was started)", () => {
    const site = rec({
      siteId: "resume",
      activatedAt: daysAgo(1),
      rotationPolicy: { autoRotate: false },
      pendingRotation: { rotationId: "r1", newKid: 2, newWpPk: null, phase: "verify", startedTs: NOW, deadlineTs: NOW + DAY },
    });
    const picked = selectRotationCandidates([site], { now: NOW, maxAgeMs: DEFAULT, maxPerRun: 5 });
    expect(names(picked)).toEqual(["resume"]);
    expect(picked[0].resuming).toBe(true);
  });
});
