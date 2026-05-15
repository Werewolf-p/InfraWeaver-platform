import {
  combineReliabilityComponents,
  normalizeLonghornCollection,
  reliabilityGradeFromScore,
  scoreArgocdHealth,
  summarizeBackupVolumes,
  summarizeLonghornBackups,
} from "@/lib/reliability";

describe("reliability helpers", () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it("normalizes Longhorn dictionary payloads", () => {
    const normalized = normalizeLonghornCollection({
      data: {
        "authentik-postgresql": { state: "Completed" },
        "openbao-data": { state: "Completed" },
      },
    });

    expect(normalized).toHaveLength(2);
    expect(normalized[0]).toEqual(expect.objectContaining({ name: "authentik-postgresql", state: "Completed" }));
  });

  it("marks fresh backups as healthy", () => {
    const status = summarizeLonghornBackups("authentik-postgresql", [
      { created: "2026-05-15T08:30:00Z", state: "Completed" },
      { created: "2026-05-14T08:30:00Z", state: "Completed" },
    ]);

    expect(status.status).toBe("healthy");
    expect(status.ageHours).toBeCloseTo(3.5, 1);
  });

  it("penalizes degraded ArgoCD health", () => {
    const score = scoreArgocdHealth({ healthy: 40, progressing: 8, degraded: 6, outOfSync: 4, total: 56 });

    expect(score.score).toBeLessThan(70);
    expect(score.detail).toContain("6 degraded");
  });

  it("combines component scores into a grade", () => {
    const combined = combineReliabilityComponents([
      { score: 100, weight: 25, detail: "nodes", status: "healthy" },
      { score: 92, weight: 25, detail: "argocd", status: "healthy" },
      { score: 98, weight: 15, detail: "uptime", status: "healthy" },
      { score: 84, weight: 20, detail: "storage", status: "warning" },
      { score: 90, weight: 15, detail: "backups", status: "healthy" },
    ]);

    expect(combined.score).toBeGreaterThanOrEqual(90);
    expect(reliabilityGradeFromScore(combined.score)).toBe("A");
  });

  it("summarizes backup status counts", () => {
    const summary = summarizeBackupVolumes([
      { name: "a", lastBackupAt: null, backupCount: 0, lastBackupState: null, ageHours: null, status: "missing" },
      { name: "b", lastBackupAt: "2026-05-15T04:00:00Z", backupCount: 3, lastBackupState: "Completed", ageHours: 8, status: "healthy" },
      { name: "c", lastBackupAt: "2026-05-13T04:00:00Z", backupCount: 2, lastBackupState: "Error", ageHours: 56, status: "stale" },
    ]);

    expect(summary).toEqual({ total: 3, healthy: 1, stale: 1, missing: 1 });
  });
});
