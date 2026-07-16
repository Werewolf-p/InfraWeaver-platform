import { NextResponse } from "next/server";
import { makeCoreApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";
import { listLonghornVolumes, loadBackupVolumeStatuses } from "@/lib/longhorn";
import {
  findOrphanBackups,
  RPO_TARGET_HOURS,
  summarizeCoverage,
  toCoverageRows,
  type PvcCoverageInput,
} from "@/lib/dr/coverage";

/**
 * DR coverage matrix: every PVC classified against Longhorn backup state.
 * Surfaces silently-unprotected volumes (local-path migrations, unscheduled
 * Longhorn volumes) that no existing view reveals. Fails closed on Longhorn
 * unavailability rather than fabricating coverage.
 */

export const GET = withAuth({ permission: "infra:read" }, async () => {
  let longhornVolumes;
  let backupStatuses;
  try {
    [longhornVolumes, backupStatuses] = await Promise.all([listLonghornVolumes(), loadBackupVolumeStatuses()]);
  } catch {
    return NextResponse.json({ available: false, reason: "longhorn_unavailable" }, { status: 200 });
  }

  const pvcsResp = await makeCoreApi().listPersistentVolumeClaimForAllNamespaces();

  // pvcKey → longhorn volume name (only Longhorn-backed PVCs appear here).
  const longhornVolNameByPvc = new Map<string, string>();
  const liveVolumeNames = new Set<string>();
  for (const volume of longhornVolumes) {
    const name = typeof volume.name === "string" ? volume.name : "";
    if (name) liveVolumeNames.add(name);
    const ks = volume.kubernetesStatus as { namespace?: string; pvcName?: string } | undefined;
    if (name && ks?.namespace && ks?.pvcName) longhornVolNameByPvc.set(`${ks.namespace}/${ks.pvcName}`, name);
  }

  // backupvolume name → {age, status, lastBackupAt}.
  const backupByVol = new Map(backupStatuses.map((b) => [b.name, b]));

  const inputs: PvcCoverageInput[] = pvcsResp.items.map((pvc) => {
    const namespace = pvc.metadata?.namespace ?? "";
    const name = pvc.metadata?.name ?? "";
    const storageClass = pvc.spec?.storageClassName ?? "";
    const capacity = pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage ?? "";
    const volName = longhornVolNameByPvc.get(`${namespace}/${name}`);
    const isLonghorn = storageClass.includes("longhorn") || volName !== undefined;
    const backup = volName ? backupByVol.get(volName) : undefined;
    const hasBackupVolume = backup !== undefined && backup.status !== "missing" && backup.lastBackupAt !== null;
    return {
      namespace,
      name,
      storageClass: storageClass || "(none)",
      capacity,
      isLonghorn,
      hasBackupVolume,
      lastBackupAgeHours: hasBackupVolume ? backup?.ageHours ?? null : null,
      // Per-volume recurring-job attribution is not reliably available via the
      // REST API here; leave schedule unknown rather than assert "no-schedule".
      hasSchedule: null,
    };
  });

  const rows = toCoverageRows(inputs);
  const summary = summarizeCoverage(rows);
  const orphans = findOrphanBackups(
    backupStatuses.map((b) => ({ volumeName: b.name, lastBackupAt: b.lastBackupAt, ageHours: b.ageHours })),
    liveVolumeNames,
  );

  return NextResponse.json({ available: true, rows, summary, orphans, rpoTargetHours: RPO_TARGET_HOURS });
});
