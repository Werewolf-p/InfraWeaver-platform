import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { buildEggConfigMap, getEggEnvironmentDefaults, getEggForGameType, getEggPorts } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, getScopedGameServerNames, hasGameHubPermission } from "@/lib/game-hub";
import { readServerManifestSha, writeServerManifest } from "@/lib/game-hub-manifest";
import { buildUniversalGameServerProbes } from "@/lib/game-hub-probes";
import { getServerDeployment, makeGameHubClients, normalizeServerName, parseImageVersion, parsePlayerHistory, readServerEgg } from "@/lib/game-hub-server";
import { getPelicanGameEgg } from "@/lib/pelican-eggs";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions, hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

function pvcSuffixForMountPath(mountPath: string) {
  return (mountPath.split("/").filter(Boolean).pop() ?? "data").replace(/[^a-z0-9-]/g, "-") || "data";
}

function quantityToString(value: string | number | null | undefined) {
  if (typeof value === "number") return String(value);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildGameServerResources(memory: string | number | null | undefined, cpu: string | number | null | undefined) {
  const memoryValue = quantityToString(memory) ?? "2Gi";
  const cpuValue = quantityToString(cpu) ?? "1";
  return {
    requests: {
      memory: memoryValue,
      cpu: cpuValue,
    },
    limits: {
      memory: memoryValue,
      cpu: cpuValue,
    },
  };
}

async function createServer(body: {
  egg?: string;
  game?: string;
  name: string;
  dnsHostname?: string;
  image?: string;
  memory?: string;
  cpu?: string;
  storage?: string;
  storageClass?: string;
  env?: Record<string, string>;
  port?: number;
  ports?: Array<{ name: string; port: number; protocol: "TCP" | "UDP" }>;
  mountPath?: string;
  groups?: string[];
}) {
  const requestedGame = body.egg ?? body.game ?? "";
  const slug = normalizeServerName(body.name);
  const baseEgg = requestedGame.startsWith("pelican:")
    ? (await getPelicanGameEgg(requestedGame.replace(/^pelican:/, ""))).egg
    : getEggForGameType(requestedGame);
  const customPorts = body.ports?.length ? body.ports : undefined;
  const eggId = requestedGame.startsWith("pelican:") ? baseEgg.id : (requestedGame || baseEgg.id);
  const egg = {
    ...baseEgg,
    id: eggId,
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
  const imageVersion = parseImageVersion(egg.dockerImage);
  const dnsHostname = typeof body.dnsHostname === "string" ? body.dnsHostname.trim().toLowerCase() : `${slug}.games.int.rlservers.com`;
  const annotations = {
    "infraweaver.io/groups": (body.groups ?? []).join(","),
    "infraweaver.io/image-version": imageVersion.version,
    "infraweaver.io/last-started": new Date().toISOString(),
    ...(dnsHostname ? { "infraweaver.io/dns-hostname": dnsHostname } : {}),
    ...(requestedGame.startsWith("pelican:") ? { "infraweaver.io/egg-source": requestedGame } : {}),
  };

  const resources = buildGameServerResources(memory, cpu);
  const { appsApi, coreApi } = makeGameHubClients();

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
      metadata: { name: slug, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver/game-type": egg.id, "infraweaver/egg": egg.id }, annotations },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: slug } },
        template: {
          metadata: { labels: { app: slug, "infraweaver/game": "true", "infraweaver/game-type": egg.id, "infraweaver/egg": egg.id }, annotations },
          spec: {
            priorityClassName: "game-server",
            terminationGracePeriodSeconds: 60,
            securityContext: egg.id === "valheim" ? { runAsUser: 0, runAsGroup: 0 } : { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            containers: [{
              name: slug,
              image: egg.dockerImage,
              imagePullPolicy: "IfNotPresent",
              ports: getEggPorts(egg).map((port) => ({ containerPort: port.port, protocol: port.protocol })),
              env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
              resources,
              volumeMounts: [{ name: "data", mountPath: egg.mountPath }],
              ...buildUniversalGameServerProbes(),
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
      metadata: {
        name: slug,
        namespace: GAME_HUB_NAMESPACE,
        labels: { app: slug, "infraweaver/game": "true" },
        annotations: dnsHostname ? {
          "external-dns.alpha.kubernetes.io/hostname": dnsHostname,
          "external-dns.alpha.kubernetes.io/ttl": "60",
        } : undefined,
      },
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

  return { name: slug, game: egg.id, status: "creating" };
}

async function cloneServer(source: string, newName: string) {
  const slug = normalizeServerName(newName);
  const { appsApi, autoscalingApi, coreApi } = makeGameHubClients();
  const sourceDeployment = await getServerDeployment(appsApi, source);
  const sourceEgg = await readServerEgg(coreApi, source, sourceDeployment);
  const sourceService = await coreApi.readNamespacedService({ name: source, namespace: GAME_HUB_NAMESPACE });
  const sourcePvcName = sourceDeployment.spec?.template?.spec?.volumes?.find((volume) => volume.persistentVolumeClaim?.claimName)?.persistentVolumeClaim?.claimName ?? `${source}-data`;
  const sourcePvc = await coreApi.readNamespacedPersistentVolumeClaim({ name: sourcePvcName, namespace: GAME_HUB_NAMESPACE }).catch(() => null);
  const pvcName = `${slug}-${pvcSuffixForMountPath(sourceEgg.mountPath)}`;
  const container = sourceDeployment.spec?.template?.spec?.containers?.[0];
  const imageVersion = parseImageVersion(container?.image ?? sourceEgg.dockerImage);
  const dnsHostname = `${slug}.games.int.rlservers.com`;

  await coreApi.createNamespacedPersistentVolumeClaim({
    namespace: GAME_HUB_NAMESPACE,
    body: {
      metadata: { name: pvcName, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver/egg": sourceEgg.id } },
      spec: {
        accessModes: sourcePvc?.spec?.accessModes ?? ["ReadWriteOnce"],
        storageClassName: sourcePvc?.spec?.storageClassName ?? "longhorn",
        resources: { requests: { storage: sourcePvc?.spec?.resources?.requests?.storage ?? sourceEgg.defaultStorage ?? "10Gi" } },
      },
    },
  });

  const volumeMount = container?.volumeMounts?.[0];
  const resources = buildGameServerResources(
    quantityToString(container?.resources?.limits?.memory) ?? quantityToString(container?.resources?.requests?.memory) ?? sourceEgg.defaultMemory ?? "2Gi",
    quantityToString(container?.resources?.limits?.cpu) ?? quantityToString(container?.resources?.requests?.cpu) ?? sourceEgg.defaultCpu ?? "1",
  );
  await appsApi.createNamespacedDeployment({
    namespace: GAME_HUB_NAMESPACE,
    body: {
      metadata: {
        name: slug,
        namespace: GAME_HUB_NAMESPACE,
        labels: { ...(sourceDeployment.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true" },
        annotations: {
          ...(sourceDeployment.metadata?.annotations ?? {}),
          "infraweaver/notes": `${sourceDeployment.metadata?.annotations?.["infraweaver/notes"] ?? ""}`,
          "infraweaver.io/image-version": imageVersion.version,
          "infraweaver.io/last-started": new Date().toISOString(),
          "infraweaver.io/dns-hostname": dnsHostname,
        },
      },
      spec: {
        replicas: sourceDeployment.spec?.replicas ?? 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: slug } },
        template: {
          metadata: {
            labels: { ...(sourceDeployment.spec?.template?.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true" },
            annotations: {
              ...(sourceDeployment.spec?.template?.metadata?.annotations ?? {}),
              "infraweaver.io/image-version": imageVersion.version,
              "infraweaver.io/last-started": new Date().toISOString(),
              "infraweaver.io/dns-hostname": dnsHostname,
            },
          },
          spec: {
            priorityClassName: "game-server",
            terminationGracePeriodSeconds: 60,
            securityContext: sourceDeployment.spec?.template?.spec?.securityContext,
            containers: [{
              name: slug,
              image: container?.image ?? sourceEgg.dockerImage,
              imagePullPolicy: "IfNotPresent",
              env: (container?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value ?? "" })),
              ports: (container?.ports ?? []).map((port) => ({ containerPort: port.containerPort, protocol: port.protocol })),
              resources,
              volumeMounts: [{ name: "data", mountPath: volumeMount?.mountPath ?? sourceEgg.mountPath }],
              ...buildUniversalGameServerProbes(),
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
      metadata: {
        name: slug,
        namespace: GAME_HUB_NAMESPACE,
        labels: { ...(sourceService.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true" },
        annotations: {
          "external-dns.alpha.kubernetes.io/hostname": dnsHostname,
          "external-dns.alpha.kubernetes.io/ttl": "60",
        },
      },
      spec: {
        type: sourceService.spec?.type ?? "NodePort",
        selector: { app: slug },
        ports: (sourceService.spec?.ports ?? []).map((port) => ({ name: port.name, port: port.port, targetPort: port.targetPort ?? port.port, protocol: port.protocol })),
      },
    },
  });

  await coreApi.createNamespacedConfigMap({
    namespace: GAME_HUB_NAMESPACE,
    body: buildEggConfigMap(
      GAME_HUB_NAMESPACE,
      slug,
      sourceEgg,
      Object.fromEntries((container?.env ?? []).map((entry) => [entry.name, entry.value ?? ""]))
    ),
  });

  try {
    const sourceHpa = await autoscalingApi.readNamespacedHorizontalPodAutoscaler({ name: source, namespace: GAME_HUB_NAMESPACE });
    await autoscalingApi.createNamespacedHorizontalPodAutoscaler({
      namespace: GAME_HUB_NAMESPACE,
      body: {
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        metadata: { name: slug, namespace: GAME_HUB_NAMESPACE },
        spec: {
          minReplicas: sourceHpa.spec?.minReplicas ?? 1,
          maxReplicas: sourceHpa.spec?.maxReplicas ?? 3,
          metrics: sourceHpa.spec?.metrics,
          behavior: sourceHpa.spec?.behavior,
          scaleTargetRef: {
            apiVersion: sourceHpa.spec?.scaleTargetRef.apiVersion ?? "apps/v1",
            kind: sourceHpa.spec?.scaleTargetRef.kind ?? "Deployment",
            name: slug,
          },
        },
      },
    });
  } catch {
    // optional HPA clone
  }

  return { name: slug, source, status: "creating" };
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
    const { appsApi, coreApi, customObjectsApi } = makeGameHubClients();
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
      const manifestShaPromise = readServerManifestSha(name).catch((error) => {
        console.warn(`readServerManifestSha failed for ${name}`, error);
        return null;
      });
      const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
      const egg = getEggForGameType(gameType);
      const replicas = deployment.status?.replicas ?? 0;
      const readyReplicas = deployment.status?.readyReplicas ?? 0;
      const maintenanceMode = deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true";
      const status = maintenanceMode ? "maintenance" : deployment.spec?.replicas === 0 ? "stopped" : readyReplicas > 0 ? "running" : replicas > 0 ? "starting" : "stopped";

      let podName = "";
      let restartCount = 0;
      let podStartTime: string | null = null;
      let podPhase: string | null = null;
      try {
        const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
        const pod = pods.items?.find((p) => p.status?.phase === "Running") ?? pods.items?.[0];
        podName = pod?.metadata?.name ?? "";
        podPhase = pod?.status?.phase ?? null;
        podStartTime = pod?.status?.startTime ? new Date(pod.status.startTime as string | Date).toISOString() : null;
        restartCount = (pod?.status?.containerStatuses ?? []).reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);
      } catch {
        podName = "";
      }

      let nodePort = 0;
      let port = 0;
      try {
        const svc = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NAMESPACE });
        port = svc.spec?.ports?.[0]?.port ?? 0;
        nodePort = svc.spec?.ports?.[0]?.nodePort ?? 0;
      } catch {
        nodePort = 0;
        port = 0;
      }

      let cpuUsage: number | null = null;
      let memoryUsage: number | null = null;
      let cpuLimit: number | null = null;
      let memoryLimit: number | null = null;
      try {
        const { parseCpuQuantity, parseMemoryBytes } = await import("@/lib/game-hub-server");
        const limits = deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits;
        cpuLimit = limits?.cpu ? parseCpuQuantity(typeof limits.cpu === "string" ? limits.cpu : null) : null;
        memoryLimit = limits?.memory ? parseMemoryBytes(typeof limits.memory === "string" ? limits.memory : null) : null;
        const podMetrics = await customObjectsApi.listNamespacedCustomObject({
          group: "metrics.k8s.io",
          version: "v1beta1",
          namespace: GAME_HUB_NAMESPACE,
          plural: "pods",
        }) as unknown as { items?: Array<{ metadata?: { name?: string }; containers?: Array<{ usage?: { cpu?: string; memory?: string } }> }> };
        const matching = (podMetrics.items ?? []).filter((item) => (item.metadata?.name ?? "").startsWith(`${name}-`));
        if (matching.length > 0) {
          cpuUsage = matching.reduce((sum, item) => sum + (item.containers ?? []).reduce((inner, c) => inner + parseCpuQuantity(c.usage?.cpu ?? null), 0), 0);
          memoryUsage = matching.reduce((sum, item) => sum + (item.containers ?? []).reduce((inner, c) => inner + parseMemoryBytes(c.usage?.memory ?? null), 0), 0);
        }
      } catch {
        // metrics not available
      }

      const description = deployment.metadata?.annotations?.["infraweaver.io/description"] ?? deployment.metadata?.annotations?.["infraweaver/description"] ?? "";
      const icon = deployment.metadata?.annotations?.["infraweaver.io/icon"] ?? deployment.metadata?.annotations?.["infraweaver/icon"] ?? "";
      const tagsRaw = deployment.metadata?.annotations?.["infraweaver.io/tags"] ?? deployment.metadata?.annotations?.["infraweaver/tags"] ?? "";
      const tags: string[] = tagsRaw ? tagsRaw.split(",").map((t: string) => t.trim()).filter(Boolean) : [];
      const groupsRaw = deployment.metadata?.annotations?.["infraweaver.io/groups"] ?? "";
      const groups: string[] = groupsRaw ? groupsRaw.split(",").map((group) => group.trim()).filter(Boolean) : [];
      const playerHistory = parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]);
      const playerCount = playerHistory[playerHistory.length - 1]?.n ?? 0;
      const image = deployment.spec?.template?.spec?.containers?.[0]?.image ?? egg.dockerImage;
      const parsedVersion = parseImageVersion(image);

      const manifestSha = await manifestShaPromise;
      const perms = getEffectivePermissions(access.groups, access.username, access.roleAssignments, `/game-hub/servers/${name}`);

      return {
        name,
        gameType,
        status,
        replicas,
        readyReplicas,
        desiredReplicas: deployment.spec?.replicas ?? 0,
        podName,
        podPhase,
        podStartTime,
        restartCount,
        port,
        nodePort,
        memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? egg.defaultMemory ?? "",
        cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? egg.defaultCpu ?? "",
        createdAt: deployment.metadata?.creationTimestamp ?? null,
        maintenanceMode,
        description,
        icon,
        tags,
        groups,
        playerCount,
        image,
        imageVersion: deployment.metadata?.annotations?.["infraweaver.io/image-version"] ?? parsedVersion.version,
        imagePinned: parsedVersion.pinned,
        cpuUsage,
        memoryUsage,
        cpuLimit,
        memoryLimit,
        permissions: {
          canRead: perms.has("*") || perms.has("game-hub:read"),
          canPlayers: perms.has("*") || perms.has("game-hub:players"),
          canConsole: perms.has("*") || perms.has("game-hub:console"),
          canFiles: perms.has("*") || perms.has("game-hub:files"),
          canAdmin: perms.has("*") || perms.has("game-hub:admin"),
          canStart: perms.has("*") || perms.has("game-hub:start"),
          canStop: perms.has("*") || perms.has("game-hub:stop"),
        },
        inGit: manifestSha !== null,
      };
    }));

    return NextResponse.json({ servers });
  } catch (error) {
    console.error("game hub server list failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("game-hub-servers-post", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:admin", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json() as {
      action?: "clone";
      source?: string;
      newName?: string;
      egg?: string;
      game?: string;
      name: string;
      dnsHostname?: string;
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

    if (body.action === "clone") {
      if (!body.source || !body.newName) {
        return NextResponse.json({ error: "source and newName are required" }, { status: 400 });
      }
      const result = await cloneServer(body.source, body.newName);
      await auditLog("game-hub:clone", session.user?.email ?? "unknown", `${body.source} -> ${result.name}`);

      try {
        await writeServerManifest(result.name, makeGameHubClients());
      } catch (gitErr) {
        console.warn("writeServerManifest failed after clone", gitErr);
      }

      return NextResponse.json(result, { status: 201 });
    }

    const result = await createServer(body);
    await auditLog("game-hub:create", session.user?.email ?? "unknown", `created ${result.name}`);

    try {
      await writeServerManifest(result.name, makeGameHubClients());
    } catch (gitErr) {
      console.warn("writeServerManifest failed after create", gitErr);
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("game hub server create failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
