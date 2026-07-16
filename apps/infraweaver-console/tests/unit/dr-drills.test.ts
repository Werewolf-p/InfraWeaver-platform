import { describe, expect, it } from "@jest/globals";
import { daysSinceLastVerifiedRestore, lastVerifiedByVolume, type DrillEntry } from "@/lib/dr/drill-analysis";

const NOW = new Date("2026-07-16T00:00:00Z").getTime();

function drill(over: Partial<DrillEntry>): DrillEntry {
  return { id: "1", volumeName: "pvc-a", pvc: "ns/a", outcome: "verified", verifiedBy: "me", timestamp: "2026-07-10T00:00:00Z", ...over };
}

describe("daysSinceLastVerifiedRestore", () => {
  it("returns days since the most recent verified restore", () => {
    const entries = [drill({ timestamp: "2026-07-14T00:00:00Z" }), drill({ timestamp: "2026-07-01T00:00:00Z" })];
    expect(daysSinceLastVerifiedRestore(entries, NOW)).toBe(2);
  });
  it("returns null when nothing was ever verified", () => {
    expect(daysSinceLastVerifiedRestore([drill({ outcome: "failed" })], NOW)).toBeNull();
    expect(daysSinceLastVerifiedRestore([], NOW)).toBeNull();
  });
  it("ignores failed/unverified drills", () => {
    const entries = [drill({ timestamp: "2026-07-15T00:00:00Z", outcome: "failed" }), drill({ timestamp: "2026-07-10T00:00:00Z", outcome: "verified" })];
    expect(daysSinceLastVerifiedRestore(entries, NOW)).toBe(6);
  });
});

describe("lastVerifiedByVolume", () => {
  it("keeps the newest verified timestamp per volume", () => {
    const map = lastVerifiedByVolume([
      drill({ volumeName: "a", timestamp: "2026-07-01T00:00:00Z" }),
      drill({ volumeName: "a", timestamp: "2026-07-10T00:00:00Z" }),
      drill({ volumeName: "b", timestamp: "2026-07-05T00:00:00Z", outcome: "failed" }),
    ]);
    expect(map.a).toBe("2026-07-10T00:00:00Z");
    expect(map.b).toBeUndefined();
  });
});
