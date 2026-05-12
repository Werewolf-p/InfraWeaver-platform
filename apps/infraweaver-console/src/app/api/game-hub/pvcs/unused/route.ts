import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext } from "@/lib/game-hub";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

function claimNamesFromDeployment(deployment: { spec?: { replicas?: number | null; template?: { spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string | null } }> } } } }) {
  if ((deployment.spec?.replicas ?? 0) <= 0) return [] as string[];
  return (deployment.spec?.template?.spec?.volumes ?? [])
    .map((volume) => volume.persistentVolumeClaim?.claimName ?? null)
    .filter((claimName): claimName is string => Boolean(claimName));
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:admin", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { appsApi, coreApi } = makeGameHubClients();
    const [deployments, pvcs] = await Promise.all([
      appsApi.listNamespacedDeployment({ namespace: GAME_HUB_NAMESPACE, labelSelector: "infraweaver/game=true" }),
      coreApi.listNamespacedPersistentVolumeClaim({ namespace: GAME_HUB_NAMESPACE }),
    ]);

    const activeClaims = new Set((deployments.items ?? []).flatMap((deployment) => claimNamesFromDeployment(deployment)));
    const unused = (pvcs.items ?? [])
      .filter((pvc) => !activeClaims.has(pvc.metadata?.name ?? ""))
      .map((pvc) => ({
        namespace: pvc.metadata?.namespace ?? GAME_HUB_NAMESPACE,
        name: pvc.metadata?.name ?? "",
        status: pvc.status?.phase ?? "Unknown",
        storageClass: pvc.spec?.storageClassName ?? "",
        capacity: pvc.spec?.resources?.requests?.storage ?? pvc.status?.capacity?.storage ?? "",
        createdAt: pvc.metadata?.creationTimestamp ? new Date(pvc.metadata.creationTimestamp as string | Date).toISOString() : null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    return NextResponse.json({ unused });
  } catch (error) {
    console.error("game-hub pvc cleanup list failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
