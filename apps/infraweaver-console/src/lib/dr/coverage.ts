/**
 * Backup / DR coverage — PURE (client-safe, unit-testable).
 *
 * Answers the question no existing view answers: "is every persistent volume
 * actually backed up?" The Backups tab only lists volumes that already HAVE
 * backups, so a local-path PVC (Jellyfin, Nextcloud — migrated off Longhorn) or
 * an unscheduled Longhorn volume is silently unprotected. This classifies the
 * FULL PVC set against Longhorn backup state.
 */

/** Last-backup age beyond this (hours) breaches the recovery-point objective. */
export const RPO_TARGET_HOURS = 24;
/** A DR readiness score below this is critical. */
export const DR_SCORE_CRITICAL = 60;
/** A DR readiness score below this warrants a warning. */
export const DR_SCORE_WARN = 85;

export type CoverageStatus = "protected" | "stale" | "no-schedule" | "unprotected";

export interface PvcCoverageInput {
  namespace: string;
  name: string;
  storageClass: string;
  capacity: string;
  /** The PVC is backed by a Longhorn volume (only Longhorn volumes can back up). */
  isLonghorn: boolean;
  /** A Longhorn backupvolume with at least one completed backup exists. */
  hasBackupVolume: boolean;
  /** Age of the most recent completed backup, or null when none. */
  lastBackupAgeHours: number | null;
  /**
   * Whether a recurring backup job keeps this volume fresh. `null` = the
   * recurring-job list was unavailable, so "no-schedule" is not asserted.
   */
  hasSchedule: boolean | null;
}

export interface PvcCoverageRow extends PvcCoverageInput {
  status: CoverageStatus;
}

export interface CoverageSummary {
  total: number;
  protected: number;
  stale: number;
  noSchedule: number;
  unprotected: number;
  coveragePct: number;
  /** 0–100 readiness: protected counts full, stale/no-schedule half, unprotected zero. */
  score: number;
}

/** Classify one PVC's backup posture. */
export function classifyPvcCoverage(input: PvcCoverageInput, rpoTargetHours: number = RPO_TARGET_HOURS): CoverageStatus {
  // Not on Longhorn (local-path, nfs, hostPath…) ⇒ no backup mechanism at all.
  if (!input.isLonghorn) return "unprotected";
  // Longhorn but never completed a backup ⇒ unprotected.
  if (!input.hasBackupVolume || input.lastBackupAgeHours === null) return "unprotected";
  // Has backups but no recurring job keeping them fresh (only asserted when known).
  if (input.hasSchedule === false) return "no-schedule";
  // Fresh enough?
  if (input.lastBackupAgeHours > rpoTargetHours) return "stale";
  return "protected";
}

export function toCoverageRows(inputs: PvcCoverageInput[], rpoTargetHours: number = RPO_TARGET_HOURS): PvcCoverageRow[] {
  const order: Record<CoverageStatus, number> = { unprotected: 0, "no-schedule": 1, stale: 2, protected: 3 };
  return inputs
    .map((input) => ({ ...input, status: classifyPvcCoverage(input, rpoTargetHours) }))
    .sort((a, b) => order[a.status] - order[b.status] || a.namespace.localeCompare(b.namespace));
}

export function summarizeCoverage(rows: PvcCoverageRow[]): CoverageSummary {
  const counts = { protected: 0, stale: 0, noSchedule: 0, unprotected: 0 };
  for (const row of rows) {
    if (row.status === "protected") counts.protected += 1;
    else if (row.status === "stale") counts.stale += 1;
    else if (row.status === "no-schedule") counts.noSchedule += 1;
    else counts.unprotected += 1;
  }
  const total = rows.length;
  const coveragePct = total > 0 ? Math.round((counts.protected / total) * 100) : 100;
  // Partial credit for stale/no-schedule (recoverable but not clean).
  const weighted = counts.protected + 0.5 * (counts.stale + counts.noSchedule);
  const score = total > 0 ? Math.round((weighted / total) * 100) : 100;
  return { total, ...counts, coveragePct, score };
}

export type DrSeverity = "ok" | "warning" | "critical";

/** Map a DR readiness score to a severity band. */
export function drSeverity(score: number): DrSeverity {
  if (score < DR_SCORE_CRITICAL) return "critical";
  if (score < DR_SCORE_WARN) return "warning";
  return "ok";
}

/** An orphaned backup: a Longhorn backupvolume whose source PVC/volume is gone. */
export interface OrphanBackup {
  volumeName: string;
  lastBackupAt: string | null;
  ageHours: number | null;
}

/**
 * Backupvolumes whose name matches neither a live Longhorn volume nor a live
 * PVC — leftover backups still consuming target storage after the app was
 * deleted. Detection only; deletion is out of scope (and would be flag-gated).
 */
export function findOrphanBackups(
  backupVolumeNames: Array<{ volumeName: string; lastBackupAt: string | null; ageHours: number | null }>,
  liveVolumeNames: ReadonlySet<string>,
): OrphanBackup[] {
  return backupVolumeNames
    .filter((backup) => !liveVolumeNames.has(backup.volumeName))
    .map((backup) => ({ volumeName: backup.volumeName, lastBackupAt: backup.lastBackupAt, ageHours: backup.ageHours }));
}
