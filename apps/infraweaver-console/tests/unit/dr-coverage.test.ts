import { describe, expect, it } from "@jest/globals";
import {
  classifyPvcCoverage,
  findOrphanBackups,
  summarizeCoverage,
  toCoverageRows,
  drSeverity,
  RPO_TARGET_HOURS,
  type PvcCoverageInput,
} from "@/lib/dr/coverage";

function pvc(over: Partial<PvcCoverageInput>): PvcCoverageInput {
  return {
    namespace: "ns",
    name: "claim",
    storageClass: "longhorn",
    capacity: "10Gi",
    isLonghorn: true,
    hasBackupVolume: true,
    lastBackupAgeHours: 2,
    hasSchedule: null,
    ...over,
  };
}

describe("classifyPvcCoverage", () => {
  it("flags a local-path (non-Longhorn) PVC as unprotected", () => {
    // Jellyfin/Nextcloud migrated off Longhorn — no backup mechanism at all.
    expect(classifyPvcCoverage(pvc({ storageClass: "local-path", isLonghorn: false }))).toBe("unprotected");
  });

  it("flags a Longhorn PVC that never completed a backup as unprotected", () => {
    expect(classifyPvcCoverage(pvc({ hasBackupVolume: false, lastBackupAgeHours: null }))).toBe("unprotected");
  });

  it("flags a backup older than the RPO target as stale", () => {
    expect(classifyPvcCoverage(pvc({ lastBackupAgeHours: RPO_TARGET_HOURS + 5 }))).toBe("stale");
  });

  it("marks a fresh, backed-up Longhorn PVC as protected", () => {
    expect(classifyPvcCoverage(pvc({ lastBackupAgeHours: 3 }))).toBe("protected");
  });

  it("asserts no-schedule only when schedule is known false", () => {
    expect(classifyPvcCoverage(pvc({ hasSchedule: false }))).toBe("no-schedule");
    expect(classifyPvcCoverage(pvc({ hasSchedule: null }))).toBe("protected");
  });
});

describe("summarizeCoverage", () => {
  it("computes coverage %, score, and orders worst-first", () => {
    const rows = toCoverageRows([
      pvc({ name: "a", storageClass: "local-path", isLonghorn: false }), // unprotected
      pvc({ name: "b", lastBackupAgeHours: 2 }), // protected
      pvc({ name: "c", lastBackupAgeHours: 100 }), // stale
    ]);
    const summary = summarizeCoverage(rows);

    expect(summary.total).toBe(3);
    expect(summary.unprotected).toBe(1);
    expect(summary.protected).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.coveragePct).toBe(33);
    expect(rows[0].status).toBe("unprotected"); // worst first
    expect(summary.score).toBeLessThan(60); // 1 protected + 0.5 stale of 3
  });
});

describe("drSeverity", () => {
  it("bands the readiness score", () => {
    expect(drSeverity(95)).toBe("ok");
    expect(drSeverity(70)).toBe("warning");
    expect(drSeverity(40)).toBe("critical");
  });
});

describe("findOrphanBackups", () => {
  it("flags backupvolumes whose source volume no longer exists", () => {
    const orphans = findOrphanBackups(
      [
        { volumeName: "pvc-live", lastBackupAt: "2026-07-16T00:00:00Z", ageHours: 5 },
        { volumeName: "pvc-deleted", lastBackupAt: "2026-06-01T00:00:00Z", ageHours: 1000 },
      ],
      new Set(["pvc-live"]),
    );
    expect(orphans).toHaveLength(1);
    expect(orphans[0].volumeName).toBe("pvc-deleted");
  });
});
