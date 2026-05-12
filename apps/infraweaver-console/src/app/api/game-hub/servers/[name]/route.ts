import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { buildEggConfigMap, getEggEnvironmentDefaults } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import {
  appendServerAudit,
  checkPortReachable,
  deleteCronJob,
  GAME_HUB_NS,
  getDeploymentGameType,
  getNodeIp,
  getServerDeployment,
  getServerPod,
  makeGameHubClients,
  parseDiscordWebhookConfig,
  parsePlayerHistory,
  readServerEgg,
  sendDiscordWebhook,
  upsertCronJob,
  validateServerToken,
} from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions, hasPermission } from "@/lib/rbac";
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

function actionPermission(action: string) {
  if (action === "start") return "game-hub:start" as const;
  if (action === "stop") return "game-hub:stop" as const;
  if (action === "scale") return "game-hub:scale" as const;
  if (["set-hpa", "remove-hpa", "update-env", "set-restart-policy", "set-notes", "update-resources", "set-maintenance", "set-schedule", "set-backup-schedule", "set-backup-target", "expand-pvc"].includes(action)) {
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

async function buildResponse(name: string, limitedToken = false, access?: Awaited<ReturnType<typeof getGameHubAccessContext>>) {
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
  const allPorts = (service?.spec?.ports ?? []).map((port) => ({
    name: port.name ?? null,
    port: port.port,
    nodePort: port.nodePort ?? null,
    protocol: port.protocol ?? "TCP",
  }));
  const status = maintenanceMode
    ? "maintenance"
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
    return NextResponse.json(await buildResponse(name, false, access));
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
    action: "start" | "stop" | "restart" | "scale" | "set-hpa" | "remove-hpa" | "update-env" | "set-restart-policy" | "set-notes" | "update-resources" | "set-maintenance" | "set-schedule" | "set-backup-schedule" | "set-backup-target" | "expand-pvc";
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
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: 1 } }, force: true, fieldManager: "infraweaver" });
      await sendDiscordWebhook(webhookConfig, "start", `🟢 ${name} started`);
    } else if (body.action === "stop") {
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: 0 } }, force: true, fieldManager: "infraweaver" });
      await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped`);
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
    }

    await auditLog(`game-hub:${body.action}`, session.user?.email ?? "unknown", `${body.action} ${name}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: body.action, details: JSON.stringify(body) });
    return NextResponse.json({ action: body.action, name });
  } catch (error) {
    console.error("server patch failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
