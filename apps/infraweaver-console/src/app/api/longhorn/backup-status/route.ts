import { NextResponse } from "next/server";
import { type LonghornBackupVolumeStatus, normalizeLonghornCollection, summarizeBackupVolumes, summarizeLonghornBackups } from "@/lib/reliability";
import { withAuth } from "@/lib/with-auth";

const LONGHORN_API = process.env.LONGHORN_API ?? "http://longhorn-frontend.longhorn-system.svc.cluster.local:80";
const MAX_BACKUP_AGE_HOURS = 36;

async function fetchLonghorn(path: string) {
  const response = await fetch(`${LONGHORN_API}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Longhorn API request failed for ${path}`);
  return response.json();
}

async function loadBackupVolumes() {
  const payload = await fetchLonghorn("/v1/backupvolumes");
  const volumes = normalizeLonghornCollection(payload);

  const statuses = await Promise.all(volumes.map(async (volume) => {
    const name = typeof volume.name === "string" ? volume.name : typeof volume.id === "string" ? volume.id : "";
    if (!name) return null;
    const backupsPayload = await fetchLonghorn(`/v1/backupvolumes/${encodeURIComponent(name)}/backups`);
    return summarizeLonghornBackups(name, normalizeLonghornCollection(backupsPayload), MAX_BACKUP_AGE_HOURS);
  }));

  return statuses.filter((status): status is LonghornBackupVolumeStatus => Boolean(status)).sort((left, right) => {
    const statusRank = { missing: 0, stale: 1, healthy: 2 } as const;
    if (statusRank[left.status] !== statusRank[right.status]) {
      return statusRank[left.status] - statusRank[right.status];
    }
    return (right.ageHours ?? -1) - (left.ageHours ?? -1);
  });
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const volumes = await loadBackupVolumes();
    return NextResponse.json({
      volumes,
      summary: summarizeBackupVolumes(volumes),
      maxAgeHours: MAX_BACKUP_AGE_HOURS,
      live: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    const volumes: LonghornBackupVolumeStatus[] = [
      { name: "authentik-postgresql", lastBackupAt: new Date(Date.now() - 6 * 3_600_000).toISOString(), backupCount: 7, lastBackupState: "Completed", ageHours: 6, status: "healthy" },
      { name: "openbao-data", lastBackupAt: new Date(Date.now() - 18 * 3_600_000).toISOString(), backupCount: 4, lastBackupState: "Completed", ageHours: 18, status: "healthy" },
      { name: "plex-config", lastBackupAt: new Date(Date.now() - 52 * 3_600_000).toISOString(), backupCount: 2, lastBackupState: "Error", ageHours: 52, status: "stale" },
    ];

    return NextResponse.json({
      volumes,
      summary: summarizeBackupVolumes(volumes),
      maxAgeHours: MAX_BACKUP_AGE_HOURS,
      live: false,
    }, { headers: { "Cache-Control": "no-store" } });
  }
});
