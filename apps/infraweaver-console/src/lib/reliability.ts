export type ReliabilityGrade = "A" | "B" | "C" | "D" | "F";
export type ReliabilityStatus = "healthy" | "warning" | "critical";

export interface ReliabilityComponentScore {
  score: number;
  weight: number;
  detail: string;
  status: ReliabilityStatus;
}

export interface ArgocdHealthSnapshot {
  healthy: number;
  progressing: number;
  degraded: number;
  outOfSync: number;
  total: number;
}

export interface LonghornBackupVolumeStatus {
  name: string;
  lastBackupAt: string | null;
  backupCount: number;
  lastBackupState: "Completed" | "Error" | "InProgress" | null;
  ageHours: number | null;
  status: "healthy" | "stale" | "missing";
}

export interface LonghornBackupSummary {
  total: number;
  healthy: number;
  stale: number;
  missing: number;
}

function clampScore(value: number) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function roundHours(value: number) {
  return Math.round(value * 10) / 10;
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function backupSortTimestamp(entry: Record<string, unknown>) {
  return parseTimestamp(entry.completedAt)
    ?? parseTimestamp(entry.snapshotCreatedAt)
    ?? parseTimestamp(entry.created)
    ?? parseTimestamp(entry.lastModified)
    ?? new Date(0);
}

export function reliabilityStatusFromScore(score: number): ReliabilityStatus {
  if (score >= 90) return "healthy";
  if (score >= 70) return "warning";
  return "critical";
}

export function reliabilityGradeFromScore(score: number): ReliabilityGrade {
  if (score >= 92) return "A";
  if (score >= 84) return "B";
  if (score >= 72) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function combineReliabilityComponents(components: ReliabilityComponentScore[]) {
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  const weightedScore = totalWeight > 0
    ? components.reduce((sum, component) => sum + (component.score * component.weight), 0) / totalWeight
    : 0;
  const score = clampScore(weightedScore);
  return {
    score,
    grade: reliabilityGradeFromScore(score),
    status: reliabilityStatusFromScore(score),
  };
}

export function normalizeLonghornCollection(input: unknown): Record<string, unknown>[] {
  const unwrap = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(value).flatMap(([name, item]) => {
        if (typeof item !== "object" || item === null) return [];
        return [{ name, ...(item as Record<string, unknown>) }];
      });
    }
    return [];
  };

  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const payload = input as { data?: unknown; items?: unknown };
    if (payload.data !== undefined || payload.items !== undefined) {
      return unwrap(payload.data ?? payload.items);
    }
  }

  return unwrap(input);
}

export function summarizeLonghornBackups(name: string, backups: Array<Record<string, unknown>>, maxAgeHours = 36): LonghornBackupVolumeStatus {
  const latest = [...backups].sort((left, right) => backupSortTimestamp(right).getTime() - backupSortTimestamp(left).getTime())[0];
  const lastBackupDate = latest ? backupSortTimestamp(latest) : null;
  const lastBackupAt = lastBackupDate && lastBackupDate.getTime() > 0 ? lastBackupDate.toISOString() : null;
  const rawState = typeof latest?.state === "string"
    ? latest.state
    : typeof latest?.status === "string"
      ? latest.status
      : null;
  const lastBackupState = rawState
    ? /complete|success/i.test(rawState)
      ? "Completed"
      : /progress|pending|running/i.test(rawState)
        ? "InProgress"
        : "Error"
    : null;
  const ageHours = lastBackupDate && lastBackupDate.getTime() > 0
    ? roundHours((Date.now() - lastBackupDate.getTime()) / 3_600_000)
    : null;

  let status: LonghornBackupVolumeStatus["status"] = "missing";
  if (ageHours !== null) {
    status = ageHours > maxAgeHours || lastBackupState === "Error" ? "stale" : "healthy";
  }

  return {
    name,
    lastBackupAt,
    backupCount: backups.length,
    lastBackupState,
    ageHours,
    status,
  };
}

export function summarizeBackupVolumes(volumes: LonghornBackupVolumeStatus[]): LonghornBackupSummary {
  return {
    total: volumes.length,
    healthy: volumes.filter((volume) => volume.status === "healthy").length,
    stale: volumes.filter((volume) => volume.status === "stale").length,
    missing: volumes.filter((volume) => volume.status === "missing").length,
  };
}

export function scoreNodeHealth(readyNodes: number, totalNodes: number): ReliabilityComponentScore {
  const score = totalNodes > 0 ? (readyNodes / totalNodes) * 100 : 0;
  return {
    score: clampScore(score),
    weight: 25,
    detail: totalNodes > 0 ? `${readyNodes}/${totalNodes} nodes Ready` : "No nodes reported",
    status: reliabilityStatusFromScore(score),
  };
}

export function scoreArgocdHealth(snapshot: ArgocdHealthSnapshot): ReliabilityComponentScore {
  const { healthy, progressing, degraded, outOfSync, total } = snapshot;
  const rawScore = total > 0
    ? (((healthy * 1) + (progressing * 0.6)) / total) * 100 - (degraded * 12) - (outOfSync * 4)
    : 0;
  const score = clampScore(rawScore);
  return {
    score,
    weight: 25,
    detail: total > 0
      ? `${healthy}/${total} healthy · ${degraded} degraded · ${outOfSync} out of sync`
      : "ArgoCD app inventory unavailable",
    status: reliabilityStatusFromScore(score),
  };
}

export function scoreUptime(overall24h: number): ReliabilityComponentScore {
  const score = clampScore(overall24h);
  return {
    score,
    weight: 15,
    detail: `${Math.max(0, Math.min(100, overall24h)).toFixed(2)}% rolling 24h uptime`,
    status: reliabilityStatusFromScore(score),
  };
}

export function scoreStorageHealth(volumes: Array<{ robustness?: unknown }>): ReliabilityComponentScore {
  if (!volumes.length) {
    return {
      score: 0,
      weight: 20,
      detail: "No Longhorn volumes reported",
      status: "critical",
    };
  }

  const weighted = volumes.reduce((sum, volume) => {
    const robustness = String(volume.robustness ?? "unknown").toLowerCase();
    if (robustness === "healthy") return sum + 100;
    if (robustness === "degraded") return sum + 55;
    if (robustness === "faulted") return sum + 10;
    return sum + 40;
  }, 0) / volumes.length;

  return {
    score: clampScore(weighted),
    weight: 20,
    detail: `${volumes.filter((volume) => String(volume.robustness ?? "").toLowerCase() === "healthy").length}/${volumes.length} Longhorn volumes healthy`,
    status: reliabilityStatusFromScore(weighted),
  };
}

export function scoreBackupHealth(summary: LonghornBackupSummary): ReliabilityComponentScore {
  const weighted = summary.total > 0
    ? ((summary.healthy * 100) + (summary.stale * 45)) / summary.total
    : 0;
  return {
    score: clampScore(weighted),
    weight: 15,
    detail: summary.total > 0
      ? `${summary.healthy}/${summary.total} backup volumes current · ${summary.stale} stale · ${summary.missing} missing`
      : "No Longhorn backup volumes reported",
    status: reliabilityStatusFromScore(weighted),
  };
}
