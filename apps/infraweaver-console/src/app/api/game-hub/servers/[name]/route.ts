import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { buildEggConfigMap, getEggEnvironmentDefaults } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { deleteServerManifest, writeServerManifest } from "@/lib/game-hub-manifest";
import {
  appendServerAudit,
  checkPortReachable,
  deleteCronJob,
  GAME_HUB_NS,
  getDeploymentGameType,
  getNodeIp,
  getServerDeployment,
  getServerPod,
  gracefulStopServer,
  makeGameHubClients,
  parseDiscordWebhookConfig,
  parseImageVersion,
  parsePlayerHistory,
  readSavedCommands,
  readServerEgg,
  sendDiscordWebhook,
  upsertCronJob,
  validateServerToken,
  writeSavedCommands,
} from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

async function upsertEggConfigMap(
  coreApi: import("@kubernetes/client-node").CoreV1Api,
  serverName: string,
  egg: import("@/lib/game-eggs").GameEgg,
  env: Record<string, string>,
) {
  const body = buildEggConfigMap(GAME_HUB_NAMESPACE, serverName, egg, env);
  try {
    await coreApi.readNamespacedConfigMap({ name: `gameserver-${serverName}-egg`, namespace: GAME_HUB_NAMESPACE });
    await coreApi.replaceNamespacedConfigMap({ name: `gameserver-${serverName}-egg`, namespace: GAME_HUB_NAMESPACE, body });
  } catch {
    await coreApi.createNamespacedConfigMap({ namespace: GAME_HUB_NAMESPACE, body });
  }
}

const MANIFEST_SYNC_ACTIONS = new Set([
  "sync-to-git",
  "set-hpa",
  "remove-hpa",
  "update-env",
  "set-restart-policy",
  "update-resources",
  "set-schedule",
  "set-backup-schedule",
  "set-backup-target",
  "expand-pvc",
  "update-image",
  "update-pull-policy",
  "update-strategy",
  "update-identity",
  "update-service-ports",
  "set-scheduled-action",
  "save-command",
  "delete-saved-command",
]);

function actionPermission(action: string) {
  if (action === "start") return "game-hub:start" as const;
  if (action === "stop") return "game-hub:stop" as const;
  if (action === "scale") return "game-hub:scale" as const;
  if (["sync-to-git", "set-hpa", "remove-hpa", "update-env", "set-restart-policy", "set-notes", "update-resources", "set-maintenance", "set-schedule", "set-backup-schedule", "set-backup-target", "expand-pvc"].includes(action)) {
    return "game-hub:admin" as const;
  }
  if (["update-image", "update-pull-policy", "update-strategy", "update-identity", "update-service-ports", "set-scheduled-action", "save-command", "delete-saved-command"].includes(action)) {
    return "game-hub:admin" as const;
  }
  return "game-hub:write" as const;
}

async function currentRestartSchedule(batchApi: import("@kubernetes/client-node").BatchV1Api, name: string) {
  try {
    const cronJob = await batchApi.readNamespacedCronJob({ name: `gameserver-${name}-restart`, namespace: GAME_HUB_NS });
    return cronJob.spec?.schedule ?? null;
  } catch {
    return null;
  }
}

async function buildResponse(name: string, limitedToken = false, access?: Awaited<ReturnType<typeof getGameHubAccessContext>>, includeYaml = false) {
  const { appsApi, autoscalingApi, batchApi, coreApi } = makeGameHubClients();
  const deployment = await getServerDeployment(appsApi, name);
  const egg = await readServerEgg(coreApi, name, deployment);
  const pod = await getServerPod(coreApi, name);

  let service = null;
  try {
    service = await coreApi.readNamespacedService({ name, namespace: GAME_HUB_NAMESPACE });
  } catch {
    service = null;
  }

  const nodeIp = await getNodeIp(coreApi, pod);
  const nodePort = service?.spec?.ports?.[0]?.nodePort ?? null;
  const portReachable = await checkPortReachable(nodeIp, nodePort ?? service?.spec?.ports?.[0]?.port ?? null);
  const maintenanceMode = deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true";

  let hpa: { enabled: boolean; min: number; max: number; cpuTarget: number | null; currentReplicas: number | null } = {
    enabled: false,
    min: 1,
    max: 3,
    cpuTarget: 70,
    currentReplicas: null,
  };
  try {
    const hpaObj = await autoscalingApi.readNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE });
    const cpuMetric = hpaObj.spec?.metrics?.find((metric) => metric.type === "Resource" && metric.resource?.name === "cpu");
    hpa = {
      enabled: true,
      min: hpaObj.spec?.minReplicas ?? 1,
      max: hpaObj.spec?.maxReplicas ?? 3,
      cpuTarget: cpuMetric?.resource?.target?.averageUtilization ?? null,
      currentReplicas: hpaObj.status?.currentReplicas ?? null,
    };
  } catch {
    // no hpa
  }

  const pvcName = deployment.spec?.template?.spec?.volumes?.find((volume) => volume.persistentVolumeClaim?.claimName)?.persistentVolumeClaim?.claimName ?? `${name}-data`;
  let pvc: import("@kubernetes/client-node").V1PersistentVolumeClaim | null = null;
  let storageClassAllowExpansion = false;
  try {
    pvc = await coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: GAME_HUB_NAMESPACE });
    if (pvc.spec?.storageClassName) {
      const storageClass = await makeGameHubClients().kc.makeApiClient((await import("@kubernetes/client-node")).StorageV1Api).readStorageClass({ name: pvc.spec.storageClassName });
      storageClassAllowExpansion = storageClass.allowVolumeExpansion === true;
    }
  } catch {
    pvc = null;
  }

  const schedule = await currentRestartSchedule(batchApi, name);
  const restartCount = (pod?.status?.containerStatuses ?? []).reduce((sum, status) => sum + (status.restartCount ?? 0), 0);
  const allPorts = (service?.spec?.ports ?? []).map((port) => {
    const tp = port.targetPort;
    const targetPort = typeof tp === "number"
      ? tp
      : typeof tp === "object" && tp !== null
        ? ((tp as { intVal?: number }).intVal ?? port.port)
        : Number(tp) || port.port;
    return {
      name: port.name ?? null,
      port: port.port,
      targetPort,
      nodePort: port.nodePort ?? null,
      protocol: port.protocol ?? "TCP",
    };
  });
  const savedCommands = await readSavedCommands(coreApi, name);
  const container = deployment.spec?.template?.spec?.containers?.[0];
  const volumeMounts = (container?.volumeMounts ?? []).map((vm) => ({
    name: vm.name,
    mountPath: vm.mountPath,
    readOnly: vm.readOnly ?? false,
  }));
  const volumesInfo = await Promise.all(
    (deployment.spec?.template?.spec?.volumes ?? []).map(async (vol) => {
      let pvcSize: string | null = null;
      if (vol.persistentVolumeClaim?.claimName) {
        try {
          const pvcObj = await coreApi.readNamespacedPersistentVolumeClaim({ name: vol.persistentVolumeClaim.claimName, namespace: GAME_HUB_NAMESPACE });
          pvcSize = pvcObj.spec?.resources?.requests?.storage ?? null;
        } catch {
          // ignore
        }
      }
      return {
        name: vol.name,
        type: vol.persistentVolumeClaim ? "pvc" : vol.configMap ? "configMap" : vol.secret ? "secret" : vol.emptyDir ? "emptyDir" : "other",
        claimName: vol.persistentVolumeClaim?.claimName ?? null,
        pvcSize,
      };
    })
  );
  const description = deployment.metadata?.annotations?.["infraweaver.io/description"] ?? deployment.metadata?.annotations?.["infraweaver/description"] ?? "";
  const icon = deployment.metadata?.annotations?.["infraweaver.io/icon"] ?? deployment.metadata?.annotations?.["infraweaver/icon"] ?? "";
  const tagsRaw = deployment.metadata?.annotations?.["infraweaver.io/tags"] ?? deployment.metadata?.annotations?.["infraweaver/tags"] ?? "";
  const tags: string[] = tagsRaw ? tagsRaw.split(",").map((t: string) => t.trim()).filter(Boolean) : [];
  const scheduledAction = deployment.metadata?.annotations?.["infraweaver.io/scheduled-action"] ?? null;
  const scheduledTime = deployment.metadata?.annotations?.["infraweaver.io/scheduled-time"] ?? null;
  const groupsRaw = deployment.metadata?.annotations?.["infraweaver.io/groups"] ?? "";
  const groups: string[] = groupsRaw ? groupsRaw.split(",").map((group) => group.trim()).filter(Boolean) : [];
  const image = container?.image ?? egg.dockerImage;
  const imageVersion = parseImageVersion(image);
  const imagePullPolicy = container?.imagePullPolicy ?? "IfNotPresent";
  const deploymentStrategy = deployment.spec?.strategy?.type ?? "RollingUpdate";
  let deploymentYaml: string | undefined;
  if (includeYaml) {
    const yaml = await import("js-yaml");
    deploymentYaml = yaml.dump(deployment, { skipInvalid: true });
  }
  const status = maintenanceMode
    ? "maintenance"
    : deployment.spec?.replicas === 0
      ? "stopped"
      : (deployment.status?.readyReplicas ?? 0) > 0
        ? "running"
        : (deployment.status?.replicas ?? 0) > 0
          ? "starting"
          : "stopped";

  if (limitedToken) {
    return {
      name,
      gameType: getDeploymentGameType(deployment),
      status,
      replicas: deployment.status?.replicas ?? 0,
      readyReplicas: deployment.status?.readyReplicas ?? 0,
      port: service?.spec?.ports?.[0]?.port ?? null,
      nodePort,
      nodeIp,
      portReachable,
      maintenanceMode,
      updatedAt: new Date().toISOString(),
    };
  }

  const perms = access
    ? getEffectivePermissions(access.groups, access.username, access.roleAssignments, `/game-hub/servers/${name}`)
    : new Set();
  const roleKey = perms.has("*") || perms.has("game-hub:admin")
    ? "game-server-admin"
    : perms.has("game-hub:write") || perms.has("game-hub:console") || perms.has("game-hub:files") || perms.has("game-hub:start") || perms.has("game-hub:stop")
      ? "game-server-operator"
      : "game-server-viewer";
  const allowedCommands = egg.commandAcl?.[roleKey] ?? [];

  return {
    name,
    gameType: getDeploymentGameType(deployment),
    egg,
    status,
    replicas: deployment.status?.replicas ?? 0,
    readyReplicas: deployment.status?.readyReplicas ?? 0,
    restartCount,
    podName: pod?.metadata?.name ?? null,
    podPhase: pod?.status?.phase ?? null,
    podStartTime: pod?.status?.startTime ? new Date(pod.status.startTime as string | Date).toISOString() : null,
    port: service?.spec?.ports?.[0]?.port ?? null,
    nodePort,
    nodeIp,
    allPorts,
    portReachable,
    hpa,
    restartPolicy: deployment.spec?.template?.spec?.restartPolicy ?? "Always",
    memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? egg.defaultMemory ?? "",
    cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? egg.defaultCpu ?? "",
    notes: deployment.metadata?.annotations?.["infraweaver/notes"] ?? "",
    env: (deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value ?? undefined })),
    createdAt: deployment.metadata?.creationTimestamp ? new Date(deployment.metadata.creationTimestamp as string | Date).toISOString() : null,
    maintenanceMode,
    description,
    icon,
    tags,
    groups,
    image,
    imageVersion: deployment.metadata?.annotations?.["infraweaver.io/image-version"] ?? imageVersion.version,
    imagePinned: imageVersion.pinned,
    imagePullPolicy,
    deploymentStrategy,
    savedCommands,
    volumeMounts,
    volumes: volumesInfo,
    scheduledAction,
    scheduledTime,
    ...(includeYaml ? { deploymentYaml } : {}),
    scheduledRestart: schedule,
    backupSchedule: deployment.metadata?.annotations?.["infraweaver/backup-schedule"] ?? null,
    backupRetention: Number.parseInt(deployment.metadata?.annotations?.["infraweaver/backup-retention"] ?? "7", 10) || 7,
    backupTarget: deployment.metadata?.annotations?.["infraweaver/backup-target"] ?? "local",
    playerHistory: parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]),
    pvc: pvc ? {
      name: pvc.metadata?.name ?? pvcName,
      size: pvc.spec?.resources?.requests?.storage ?? null,
      storageClass: pvc.spec?.storageClassName ?? null,
      allowExpansion: storageClassAllowExpansion,
    } : null,
    permissions: {
      canConsole: perms.has("*") || perms.has("game-hub:console") || allowedCommands.length > 0,
      canAdmin: perms.has("*") || perms.has("game-hub:admin"),
      canStart: perms.has("*") || perms.has("game-hub:start"),
      canStop: perms.has("*") || perms.has("game-hub:stop"),
      canWriteFiles: perms.has("*") || perms.has("game-hub:files"),
      readOnlyFiles: !(perms.has("*") || perms.has("game-hub:files")),
    },
    commandAcl: egg.commandAcl ?? {},
    allowedCommands,
    nasTargets: {
      truenas: Boolean(process.env.TRUENAS_HOST),
      synology: Boolean(process.env.SYNOLOGY_HOST),
    },
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const token = req.nextUrl.searchParams.get("token");

  if (token) {
    try {
      const { coreApi } = makeGameHubClients();
      const valid = await validateServerToken(coreApi, name, token);
      if (!valid) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      return NextResponse.json(await buildResponse(name, true));
    } catch (error) {
      console.error("token auth server get failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const includeYaml = req.nextUrl.searchParams.get("includeYaml") === "1";
    return NextResponse.json(await buildResponse(name, false, access, includeYaml));
  } catch (error) {
    console.error("server GET failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-delete", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { appsApi, batchApi, coreApi } = makeGameHubClients();
    await appsApi.deleteNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedService({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedConfigMap({ name: `gameserver-${name}-audit`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedSecret({ name: `gameserver-${name}-tokens`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await deleteCronJob(batchApi, `gameserver-${name}-restart`);
    await deleteCronJob(batchApi, `gameserver-${name}-backup`);

    try {
      const pvcs = await coreApi.listNamespacedPersistentVolumeClaim({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
      await Promise.all(pvcs.items.map((pvc) =>
        coreApi.deleteNamespacedPersistentVolumeClaim({ name: pvc.metadata?.name ?? "", namespace: GAME_HUB_NAMESPACE }).catch(() => undefined)
      ));
    } catch {
      await coreApi.deleteNamespacedPersistentVolumeClaim({ name: `${name}-data`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    }

    await auditLog("game-hub:delete", session.user?.email ?? "unknown", `deleted ${name}`);

    // ── IaC write-back: remove manifest from git ──────────────────────────────
    try {
      await deleteServerManifest(name);
    } catch (gitErr) {
      console.error("Git delete failed (k8s delete succeeded):", gitErr);
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("server delete failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-patch", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as {
    action: "start" | "stop" | "restart" | "scale" | "set-hpa" | "remove-hpa" | "update-env" | "set-restart-policy" | "set-notes" | "update-resources" | "set-maintenance" | "set-schedule" | "set-backup-schedule" | "set-backup-target" | "expand-pvc" | "update-image" | "update-pull-policy" | "update-strategy" | "update-identity" | "update-service-ports" | "set-scheduled-action" | "save-command" | "delete-saved-command" | "sync-to-git";
    replicas?: number;
    hpaMin?: number;
    hpaMax?: number;
    hpaCpuTarget?: number;
    env?: Record<string, string>;
    restartPolicy?: boolean;
    notes?: string;
    memory?: string;
    cpu?: string;
    enabled?: boolean;
    cronExpr?: string | null;
    retention?: number;
    target?: string;
    pvcName?: string;
    newSize?: string;
    image?: string;
    pullPolicy?: "Always" | "IfNotPresent" | "Never";
    strategy?: "RollingUpdate" | "Recreate";
    description?: string;
    icon?: string;
    tags?: string[];
    groups?: string[];
    ports?: Array<{ name: string; port: number; targetPort?: number; protocol?: "TCP" | "UDP"; nodePort?: number }>;
    scheduledAction?: string | null;
    scheduledTime?: string | null;
    command?: { id?: string; label: string; cmd: string; color?: string; description?: string };
    commandId?: string;
  };

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, actionPermission(body.action), name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const webhookConfig = parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);

    if (body.action === "start") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { replicas: 1 }, metadata: { annotations: { "infraweaver.io/last-started": new Date().toISOString() } } },
        force: true,
        fieldManager: "infraweaver",
      });
      await sendDiscordWebhook(webhookConfig, "start", `🟢 ${name} started`);
    } else if (body.action === "stop") {
      const result = await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped${result.exitedGracefully ? " gracefully" : ""}`);
    } else if (body.action === "restart") {
      const pods = await clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
      for (const pod of pods.items ?? []) {
        await clients.coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
      }
      await sendDiscordWebhook(webhookConfig, "restart", `🔄 ${name} restarted`);
    } else if (body.action === "scale") {
      await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
      const count = Math.max(0, Math.min(body.replicas ?? 1, 10));
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: count } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "set-hpa") {
      const min = Math.max(1, body.hpaMin ?? 1);
      const max = Math.max(min, body.hpaMax ?? 3);
      const cpu = Math.min(100, Math.max(10, body.hpaCpuTarget ?? 70));
      const hpaSpec = {
        apiVersion: "autoscaling/v2",
        kind: "HorizontalPodAutoscaler",
        metadata: { name, namespace: GAME_HUB_NAMESPACE },
        spec: {
          scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
          minReplicas: min,
          maxReplicas: max,
          metrics: [{ type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: cpu } } }],
        },
      };
      try {
        await clients.autoscalingApi.patchNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE, body: hpaSpec, force: true, fieldManager: "infraweaver" });
      } catch {
        await clients.autoscalingApi.createNamespacedHorizontalPodAutoscaler({ namespace: GAME_HUB_NAMESPACE, body: hpaSpec });
      }
    } else if (body.action === "remove-hpa") {
      await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    } else if (body.action === "update-env") {
      const envVars = Object.entries(body.env ?? {}).map(([key, value]) => ({ name: key, value }));
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, env: envVars }] } } } },
        force: true,
        fieldManager: "infraweaver",
      });
      await upsertEggConfigMap(clients.coreApi, name, egg, body.env ?? getEggEnvironmentDefaults(egg));
    } else if (body.action === "set-restart-policy") {
      const policy = body.restartPolicy === true ? "Always" : "OnFailure";
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { template: { spec: { restartPolicy: policy } } } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "set-notes") {
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { metadata: { annotations: { "infraweaver/notes": body.notes ?? "" } } }, force: true, fieldManager: "infraweaver" });
    } else if (body.action === "update-resources") {
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, resources: { limits: { memory: body.memory, cpu: body.cpu }, requests: { memory: body.memory, cpu: body.cpu } } }] } } } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-maintenance") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/maintenance": body.enabled ? "true" : "false" } } },
        fieldManager: "infraweaver",
        force: true,
      });
    } else if (body.action === "set-schedule") {
      if (body.cronExpr) {
        await upsertCronJob(clients.batchApi, `gameserver-${name}-restart`, body.cronExpr, `kubectl rollout restart deployment/${name} -n game-hub`, { app: name, "infraweaver/game": "true", "infraweaver/type": "scheduled-restart" });
      } else {
        await deleteCronJob(clients.batchApi, `gameserver-${name}-restart`);
      }
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/restart-schedule": body.cronExpr ?? "" } } },
        fieldManager: "infraweaver",
        force: true,
      });
    } else if (body.action === "set-backup-schedule") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/backup-schedule": body.cronExpr ?? "", "infraweaver/backup-retention": String(body.retention ?? 7) } } },
        fieldManager: "infraweaver",
        force: true,
      });
    } else if (body.action === "set-backup-target") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/backup-target": body.target ?? "local" } } },
        fieldManager: "infraweaver",
        force: true,
      });
    } else if (body.action === "expand-pvc") {
      if (!body.pvcName || !body.newSize) {
        return NextResponse.json({ error: "pvcName and newSize are required" }, { status: 400 });
      }
      await clients.coreApi.patchNamespacedPersistentVolumeClaim({
        name: body.pvcName,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { resources: { requests: { storage: body.newSize } } } },
        fieldManager: "infraweaver",
        force: true,
      });
    } else if (body.action === "update-image") {
      if (!body.image) return NextResponse.json({ error: "image is required" }, { status: 400 });
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      const parsedVersion = parseImageVersion(body.image);
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: { annotations: { "infraweaver.io/image-version": parsedVersion.version } },
          spec: { template: { metadata: { annotations: { "infraweaver.io/image-version": parsedVersion.version } }, spec: { containers: [{ name: containerName, image: body.image }] } } },
        },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-pull-policy") {
      if (!body.pullPolicy) return NextResponse.json({ error: "pullPolicy is required" }, { status: 400 });
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, imagePullPolicy: body.pullPolicy }] } } } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-strategy") {
      const strategyType = body.strategy === "Recreate" ? "Recreate" : "RollingUpdate";
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { strategy: { type: strategyType } } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-identity") {
      const annotations: Record<string, string> = {};
      if (body.description !== undefined) annotations["infraweaver.io/description"] = body.description;
      if (body.icon !== undefined) annotations["infraweaver.io/icon"] = body.icon;
      if (body.tags !== undefined) annotations["infraweaver.io/tags"] = (body.tags ?? []).join(",");
      if (body.groups !== undefined) annotations["infraweaver.io/groups"] = (body.groups ?? []).join(",");
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-service-ports") {
      if (!body.ports?.length) return NextResponse.json({ error: "ports array is required" }, { status: 400 });
      await clients.coreApi.patchNamespacedService({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          spec: {
            ports: body.ports.map((p) => ({
              name: p.name,
              port: p.port,
              targetPort: p.targetPort ?? p.port,
              protocol: p.protocol ?? "TCP",
              ...(p.nodePort ? { nodePort: p.nodePort } : {}),
            })),
          },
        },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-scheduled-action") {
      const annotations: Record<string, string> = {
        "infraweaver.io/scheduled-action": body.scheduledAction ?? "",
        "infraweaver.io/scheduled-time": body.scheduledTime ?? "",
      };
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations } },
        force: true,
        fieldManager: "infraweaver",
      });
    } else if (body.action === "save-command") {
      if (!body.command?.label || !body.command?.cmd) return NextResponse.json({ error: "command.label and command.cmd are required" }, { status: 400 });
      const existing = await readSavedCommands(clients.coreApi, name);
      const { randomUUID } = await import("crypto");
      const id = body.command.id ?? randomUUID();
      const filtered = existing.filter((c) => c.id !== id);
      await writeSavedCommands(clients.coreApi, name, [
        ...filtered,
        { id, label: body.command.label, cmd: body.command.cmd, color: body.command.color, description: body.command.description },
      ]);
    } else if (body.action === "delete-saved-command") {
      if (!body.commandId) return NextResponse.json({ error: "commandId is required" }, { status: 400 });
      const existing = await readSavedCommands(clients.coreApi, name);
      await writeSavedCommands(clients.coreApi, name, existing.filter((c) => c.id !== body.commandId));
    } else if (body.action === "sync-to-git") {
      // Manifest sync is handled below.
    }

    await auditLog(`game-hub:${body.action}`, session.user?.email ?? "unknown", `${body.action} ${name}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: body.action, details: JSON.stringify(body) });

    // ── IaC write-back for config-changing actions ────────────────────────────
    // Runtime-only actions (start/stop/restart/scale/set-maintenance/set-notes)
    // are intentionally excluded so git only tracks rebuildable server config.
    if (MANIFEST_SYNC_ACTIONS.has(body.action)) {
      try {
        await writeServerManifest(name, clients);
      } catch (gitErr) {
        console.warn(`writeServerManifest failed for action ${body.action} on ${name}`, gitErr);
      }
    }

    return NextResponse.json({ action: body.action, name });
  } catch (error) {
    console.error("server patch failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
