import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { GAME_HUB_NS, getDeploymentGameType, getServerDeployment, makeGameHubClients } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { safeError } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const service = await clients.coreApi.readNamespacedService({ name, namespace: GAME_HUB_NS }).catch(() => null);
    const pvcName = deployment.spec?.template?.spec?.volumes
      ?.find((volume) => volume.persistentVolumeClaim?.claimName)
      ?.persistentVolumeClaim?.claimName ?? `${name}-data`;
    const pvc = await clients.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: GAME_HUB_NS }).catch(() => null);
    const container = deployment.spec?.template?.spec?.containers?.[0];
    const tagsRaw = deployment.metadata?.annotations?.["infraweaver.io/tags"] ?? deployment.metadata?.annotations?.["infraweaver/tags"] ?? "";
    const groupsRaw = deployment.metadata?.annotations?.["infraweaver.io/groups"] ?? "";
    const ports = (service?.spec?.ports?.length
      ? service.spec.ports.map((port) => ({
          name: port.name ?? `${port.protocol ?? "TCP"}-${port.port}`,
          port: port.port,
          protocol: port.protocol ?? "TCP",
        }))
      : (container?.ports ?? []).map((port) => ({
          name: port.name ?? `${port.protocol ?? "TCP"}-${port.containerPort}`,
          port: port.containerPort,
          protocol: port.protocol ?? "TCP",
        })));

    return NextResponse.json({
      templateVersion: "1.0",
      exportedAt: new Date().toISOString(),
      server: {
        gameType: getDeploymentGameType(deployment),
        image: container?.image ?? "",
        resources: {
          cpu: typeof container?.resources?.limits?.cpu === "string" ? container.resources.limits.cpu : "",
          memory: typeof container?.resources?.limits?.memory === "string" ? container.resources.limits.memory : "",
          cpuRequest: typeof container?.resources?.requests?.cpu === "string" ? container.resources.requests.cpu : "",
          memoryRequest: typeof container?.resources?.requests?.memory === "string" ? container.resources.requests.memory : "",
        },
        env: (container?.env ?? [])
          .filter((entry) => entry.name !== "SERVER_PASSWORD" && typeof entry.value === "string")
          .map((entry) => ({ name: entry.name, value: entry.value ?? "" })),
        ports,
        storage: {
          size: typeof pvc?.spec?.resources?.requests?.storage === "string" ? pvc.spec.resources.requests.storage : "",
          storageClass: pvc?.spec?.storageClassName ?? "",
        },
        tags: tagsRaw ? tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
        groups: groupsRaw ? groupsRaw.split(",").map((group) => group.trim()).filter(Boolean) : [],
        description: deployment.metadata?.annotations?.["infraweaver.io/description"] ?? deployment.metadata?.annotations?.["infraweaver/description"] ?? "",
      },
    });
  } catch (error) {
    console.error("template export failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
