import { describe, expect, it } from "@jest/globals";
import { matchesCronDate, nextCronRun, parseCronPart } from "@/lib/cron-utils";

describe("cron utils", () => {
  it("parses wildcard steps", () => {
    expect(Array.from(parseCronPart("*/15", 0, 59))).toEqual([0, 15, 30, 45]);
  });

  it("matches cron expressions", () => {
    expect(matchesCronDate(new Date("2026-05-15T02:00:00Z"), "0 2 * * *")).toBe(true);
    expect(matchesCronDate(new Date("2026-05-15T02:10:00Z"), "0 2 * * *")).toBe(false);
  });

  it("calculates the next run", () => {
    const next = nextCronRun("0 2 * * *", new Date("2026-05-15T01:30:00Z"));
    expect(next?.toISOString()).toBe("2026-05-15T02:00:00.000Z");
  });
});
