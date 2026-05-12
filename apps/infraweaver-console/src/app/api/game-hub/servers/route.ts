import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildEggConfigMap, getEggEnvironmentDefaults, getEggForGameType, getEggPorts } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, getScopedGameServerNames, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

function pvcSuffixForMountPath(mountPath: string) {
  return (mountPath.split("/").filter(Boolean).pop() ?? "data").replace(/[^a-z0-9-]/g, "-") || "data";
}

function normalizeServerName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  const scopedServers = new Set(getScopedGameServerNames(access.roleAssignments));
  const canReadAll = hasPermission(access.groups, "game-hub:read", access.roleAssignments, "/game-hub/", access.username);
  if (!canReadAll && scopedServers.size === 0) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const deployments = await appsApi.listNamespacedDeployment({
      namespace: GAME_HUB_NAMESPACE,
      labelSelector: "infraweaver/game=true",
    });

    const visibleDeployments = (deployments.items ?? []).filter((deployment) => {
      const name = deployment.metadata?.name ?? "";
      return canReadAll || scopedServers.has(name) || hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name);
    });

    const servers = await Promise.all(visibleDeployments.map(async (deployment) => {
      const name = deployment.metadata?.name ?? "";
      const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
      const egg = getEggForGameType(gameType);
      const replicas = deployment.status?.replicas ?? 0;
      const readyReplicas = deployment.status?.readyReplicas ?? 0;
      const status = deployment.spec?.replicas === 0 ? "stopped" : readyReplicas > 0 ? "running" : replicas > 0 ? "starting" : "stopped";

      let podName = "";
      try {
        const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
        podName = pods.items?.[0]?.metadata?.name ?? "";
      } catch {}

      let nodePort = 0;
      let port = 0;
      try {
        const svc = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NAMESPACE });
        port = svc.spec?.ports?.[0]?.port ?? 0;
        nodePort = svc.spec?.ports?.[0]?.nodePort ?? 0;
      } catch {}

      return {
        name,
        gameType,
        status,
        replicas,
        readyReplicas,
        podName,
        port,
        nodePort,
        memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? egg.defaultMemory ?? "",
        cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? egg.defaultCpu ?? "",
        createdAt: deployment.metadata?.creationTimestamp ?? null,
      };
    }));

    return NextResponse.json({ servers });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:admin", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json() as {
      egg?: string;
      game?: string;
      name: string;
      image?: string;
      memory?: string;
      cpu?: string;
      storage?: string;
      storageClass?: string;
      env?: Record<string, string>;
      port?: number;
      ports?: Array<{ name: string; port: number; protocol: "TCP" | "UDP" }>;
      mountPath?: string;
    };

    const requestedGame = body.egg ?? body.game ?? "";
    const slug = normalizeServerName(body.name);
    const baseEgg = getEggForGameType(requestedGame);
    const customPorts = body.ports?.length ? body.ports : undefined;
    const egg = {
      ...baseEgg,
      id: requestedGame || baseEgg.id,
      name: baseEgg.id === "generic" ? body.name : baseEgg.name,
      dockerImage: body.image ?? baseEgg.dockerImage,
      gamePort: body.port ?? baseEgg.gamePort,
      mountPath: body.mountPath ?? baseEgg.mountPath,
      ports: customPorts ?? getEggPorts({ ...baseEgg, gamePort: body.port ?? baseEgg.gamePort }),
    };
    const env = { ...getEggEnvironmentDefaults(egg), ...(body.env ?? {}) };
    const memory = body.memory ?? egg.defaultMemory ?? "2Gi";
    const cpu = body.cpu ?? egg.defaultCpu ?? "1";
    const storage = body.storage ?? egg.defaultStorage ?? "10Gi";
    const storageClass = body.storageClass ?? "longhorn";
    const pvcName = `${slug}-${pvcSuffixForMountPath(egg.mountPath)}`;

    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    await coreApi.createNamespacedPersistentVolumeClaim({
      namespace: GAME_HUB_NAMESPACE,
      body: {
        metadata: { name: pvcName, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver/egg": egg.id } },
        spec: { accessModes: ["ReadWriteOnce"], storageClassName: storageClass, resources: { requests: { storage } } },
      },
    });

    await appsApi.createNamespacedDeployment({
      namespace: GAME_HUB_NAMESPACE,
      body: {
        metadata: { name: slug, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver/game-type": egg.id, "infraweaver/egg": egg.id } },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: slug } },
          template: {
            metadata: { labels: { app: slug, "infraweaver/game": "true" } },
            spec: {
              securityContext: egg.id === "valheim" ? { runAsUser: 0 } : { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              containers: [{
                name: slug,
                image: egg.dockerImage,
                ports: getEggPorts(egg).map((port) => ({ containerPort: port.port, protocol: port.protocol })),
                env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
                resources: { requests: { memory: "512Mi", cpu: "250m" }, limits: { memory, cpu } },
                volumeMounts: [{ name: "data", mountPath: egg.mountPath }],
              }],
              volumes: [{ name: "data", persistentVolumeClaim: { claimName: pvcName } }],
            },
          },
        },
      },
    });

    await coreApi.createNamespacedService({
      namespace: GAME_HUB_NAMESPACE,
      body: {
        metadata: { name: slug, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true" } },
        spec: {
          type: "NodePort",
          selector: { app: slug },
          ports: getEggPorts(egg).map((port) => ({ name: port.name, port: port.port, targetPort: port.port, protocol: port.protocol })),
        },
      },
    });

    await coreApi.createNamespacedConfigMap({
      namespace: GAME_HUB_NAMESPACE,
      body: buildEggConfigMap(GAME_HUB_NAMESPACE, slug, egg, env),
    });

    return NextResponse.json({ name: slug, game: egg.id, status: "creating" }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
