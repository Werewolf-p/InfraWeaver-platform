import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext } from "@/lib/game-hub";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

function pvcInUse(
  deployments: Array<{ spec?: { replicas?: number | null; template?: { spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string | null } }> } } } }>,
  pvcName: string,
) {
  return deployments.some((deployment) => (deployment.spec?.replicas ?? 0) > 0 && (deployment.spec?.template?.spec?.volumes ?? []).some((volume) => volume.persistentVolumeClaim?.claimName === pvcName));
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:admin", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { appsApi, coreApi } = makeGameHubClients();
    const deployments = await appsApi.listNamespacedDeployment({ namespace: GAME_HUB_NAMESPACE, labelSelector: "infraweaver/game=true" });
    if (pvcInUse(deployments.items ?? [], name)) {
      return NextResponse.json({ error: "PVC is still attached to a running deployment" }, { status: 409 });
    }

    await coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace: GAME_HUB_NAMESPACE });
    await auditLog("game-hub:pvc-delete", session.user?.email ?? "unknown", `${GAME_HUB_NAMESPACE}/${name}`);
    return NextResponse.json({ deleted: true, name });
  } catch (error) {
    console.error("game-hub pvc delete failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
