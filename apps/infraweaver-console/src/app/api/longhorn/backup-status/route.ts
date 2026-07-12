import { NextResponse } from "next/server";
import { MAX_BACKUP_AGE_HOURS, loadBackupVolumeStatuses } from "@/lib/longhorn";
import { summarizeBackupVolumes } from "@/lib/reliability";
import { unavailableResponse } from "@/lib/route-utils";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    const volumes = await loadBackupVolumeStatuses();
    return NextResponse.json({
      volumes,
      summary: summarizeBackupVolumes(volumes),
      maxAgeHours: MAX_BACKUP_AGE_HOURS,
      live: true,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // FAIL CLOSED: no fabricated backup statuses when Longhorn is unreachable.
    return unavailableResponse(error);
  }
});
