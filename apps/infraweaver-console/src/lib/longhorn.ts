// ─────────────────────────────────────────────────────────────────────────────
// longhorn.ts — shared Longhorn REST helpers, consolidating the inline fetch +
// backup-volume aggregation duplicated across /api/longhorn/backup-status,
// /api/longhorn/volumes, /api/storage/pvs and /api/health/reliability.
// Normalization/summarization primitives stay in @/lib/reliability.
// ─────────────────────────────────────────────────────────────────────────────
import {
  type LonghornBackupVolumeStatus,
  normalizeLonghornCollection,
  summarizeLonghornBackups,
} from "@/lib/reliability";

const LONGHORN_API = process.env.LONGHORN_API ?? "http://longhorn-frontend.longhorn-system.svc.cluster.local:80";
const LONGHORN_TIMEOUT_MS = 8000;

/** A backup volume with no completed backup within this window counts as stale. */
export const MAX_BACKUP_AGE_HOURS = 36;

/**
 * Fetch a Longhorn API path (must start with "/", e.g. "/v1/volumes") with the
 * canonical headers/timeout used by the existing routes. Throws on non-2xx.
 */
export async function longhornFetch(path: string): Promise<unknown> {
  const response = await fetch(`${LONGHORN_API}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(LONGHORN_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Longhorn API request failed for ${path}`);
  return response.json();
}

/** List all Longhorn volumes as normalized records. */
export async function listLonghornVolumes(): Promise<Record<string, unknown>[]> {
  return normalizeLonghornCollection(await longhornFetch("/v1/volumes"));
}

/**
 * Load per-volume backup statuses: enumerates /v1/backupvolumes, fetches each
 * volume's backups, and summarizes them against `maxAgeHours`. Sorted worst
 * first (missing → stale → healthy, then oldest backup first) exactly like
 * /api/longhorn/backup-status; the ordering is irrelevant to callers that only
 * feed the result into summarizeBackupVolumes.
 */
export async function loadBackupVolumeStatuses(
  maxAgeHours: number = MAX_BACKUP_AGE_HOURS,
): Promise<LonghornBackupVolumeStatus[]> {
  const volumes = normalizeLonghornCollection(await longhornFetch("/v1/backupvolumes"));

  const statuses = await Promise.all(volumes.map(async (volume) => {
    const name = typeof volume.name === "string" ? volume.name : typeof volume.id === "string" ? volume.id : "";
    if (!name) return null;
    const backupsPayload = await longhornFetch(`/v1/backupvolumes/${encodeURIComponent(name)}/backups`);
    return summarizeLonghornBackups(name, normalizeLonghornCollection(backupsPayload), maxAgeHours);
  }));

  const statusRank = { missing: 0, stale: 1, healthy: 2 } as const;
  return statuses
    .filter((status): status is LonghornBackupVolumeStatus => Boolean(status))
    .sort((left, right) => {
      if (statusRank[left.status] !== statusRank[right.status]) {
        return statusRank[left.status] - statusRank[right.status];
      }
      return (right.ageHours ?? -1) - (left.ageHours ?? -1);
    });
}
