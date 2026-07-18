/** @jest-environment node */
/**
 * §8 per-site rotation interval bounds. The clamp is the guardrail that stops an
 * operator (or a hand-edited record) from setting a cadence that would hammer the
 * signing path (too small) or silently disable rotation (too large).
 */
import {
  clampRotationIntervalMs,
  MIN_SITE_INTERVAL_MS,
  MAX_SITE_INTERVAL_MS,
} from "@/addons/wordpress-manager/lib/rotation-policy";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("clampRotationIntervalMs", () => {
  test("floor is 1 hour", () => {
    expect(MIN_SITE_INTERVAL_MS).toBe(HOUR);
    expect(clampRotationIntervalMs(0)).toBe(HOUR);
    expect(clampRotationIntervalMs(60_000)).toBe(HOUR);
    expect(clampRotationIntervalMs(-5)).toBe(HOUR);
  });

  test("ceiling is 1 year", () => {
    expect(MAX_SITE_INTERVAL_MS).toBe(365 * DAY);
    expect(clampRotationIntervalMs(1000 * 365 * DAY)).toBe(365 * DAY);
  });

  test("passes an in-range value through, floored to whole ms", () => {
    expect(clampRotationIntervalMs(7 * DAY)).toBe(7 * DAY);
    expect(clampRotationIntervalMs(12 * HOUR + 0.9)).toBe(12 * HOUR);
  });

  test("non-finite input fails safe to the floor (rotate sooner, never disable)", () => {
    expect(clampRotationIntervalMs(NaN)).toBe(HOUR);
    expect(clampRotationIntervalMs(Infinity)).toBe(MIN_SITE_INTERVAL_MS);
  });
});
