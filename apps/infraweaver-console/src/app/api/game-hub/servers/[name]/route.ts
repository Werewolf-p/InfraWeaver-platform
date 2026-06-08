import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { buildEggConfigMap } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { deleteServerManifest, getGitHubConfig, writeServerManifest } from "@/lib/game-hub-manifest";
import {
  appendServerAudit,
  buildPowerScheduleCron,
  checkPortReachable,
  createCronJob,
  deleteCronJob,
  GAME_HUB_NS,
  forceStopServer,
  getDeploymentGameType,
  getNodeIp,
  getServerDeployment,
  getServerPod,
  gracefulStopServer,
  makeGameHubClients,
  parseDiscordWebhookConfig,
  parseImageVersion,
  parsePlayerHistory,
  parsePowerSchedule,
  readSavedCommands,
  readServerEgg,
  sendDiscordWebhook,
  validateServerToken,
  writeSavedCommands,
  isKubernetesNotFoundError,
} from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

// Allow up to 60s for long operations (start/stop/restart/exec)
export const maxDuration = 60;

const VALID_ACTIONS = [
  "start", "stop", "force-stop", "restart", "scale", "set-hpa", "remove-hpa", "update-env",
  "set-restart-policy", "set-autopause", "set-notes", "update-notes", "update-resources", "set-maintenance",
  "set-schedule", "set-backup-schedule", "set-backup-target", "set-alert-thresholds",
  "expand-pvc", "update-image", "pin-image-version", "unpin-image-version",
  "update-pull-policy", "update-strategy", "update-identity", "update-tags",
  "update-service-ports", "set-scheduled-action", "save-command", "delete-saved-command",
  "set-join-password", "set-command-blocklist", "add-announcement", "set-restart-reason",
  "sync-to-git",
] as const;

const patchActionSchema = z.object({
  action: z.enum(VALID_ACTIONS),
});

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
  // Power state MUST be written to git: ArgoCD runs with selfHeal:true, so a
  // cluster-only `replicas: 0` (stop) is treated as drift and reverted back to
  // the git desired state — the server "starts again even after shutdown".
  // Persisting the replica count to git makes ArgoCD respect start/stop/scale.
  "start",
  "stop",
  "force-stop",
  "scale",
  "sync-to-git",
  "set-hpa",
  "remove-hpa",
  "update-env",
  "set-restart-policy",
  "update-resources",
  "set-schedule",
  "set-backup-schedule",
  "set-backup-target",
  "set-alert-thresholds",
  "expand-pvc",
  "update-image",
  "pin-image-version",
  "unpin-image-version",
  "update-pull-policy",
  "update-strategy",
  "update-identity",
  "update-tags",
  "update-service-ports",
  "set-scheduled-action",
  "save-command",
  "delete-saved-command",
]);

function actionPermission(action: string) {
  if (action === "start") return "game-hub:start" as const;
  if (action === "stop" || action === "force-stop") return "game-hub:stop" as const;
  if (action === "scale") return "game-hub:scale" as const;
  if (["sync-to-git", "set-hpa", "remove-hpa", "update-env", "set-restart-policy", "set-notes", "update-notes", "update-resources", "set-maintenance", "set-schedule", "set-backup-schedule", "set-backup-target", "set-alert-thresholds", "expand-pvc"].includes(action)) {
    return "game-hub:admin" as const;
  }
  if (["update-image", "pin-image-version", "unpin-image-version", "update-pull-policy", "update-strategy", "update-identity", "update-tags", "update-service-ports", "set-scheduled-action", "save-command", "delete-saved-command"].includes(action)) {
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

function replaceImageTag(image: string, nextTag: string) {
  const base = image.includes("@") ? image.split("@")[0] ?? image : image;
  const lastColon = base.lastIndexOf(":");
  const lastSlash = base.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return `${base.slice(0, lastColon)}:${nextTag}`;
  }
  return `${base}:${nextTag}`;
}

type ServerAnnouncement = {
  id: string;
  schedule: string;
  message: string;
};

function parseStringArrayAnnotation(raw: string | undefined) {
  if (!raw) return [] as string[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [] as string[];
  }
}

function parseAnnouncementsAnnotation(raw: string | undefined) {
  if (!raw) return [] as ServerAnnouncement[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [] as ServerAnnouncement[];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [] as ServerAnnouncement[];
      const id = typeof entry.id === "string" ? entry.id : "";
      const schedule = typeof entry.schedule === "string" ? entry.schedule : "";
      const message = typeof entry.message === "string" ? entry.message : "";
      if (!id || !schedule || !message) return [] as ServerAnnouncement[];
      return [{ id, schedule, message }];
    });
  } catch {
    return [] as ServerAnnouncement[];
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

  // Detect active init container (installer running during first boot / reinstall).
  const activeInitContainer = (pod?.status?.initContainerStatuses ?? []).find(
    (cs) => cs.state?.running != null && !cs.ready,
  );
  const hasInstallingInitContainer = activeInitContainer != null;

  // Crash detection: inspect container wait/termination reasons from the pod status.
  const primaryContainerStatus = pod?.status?.containerStatuses?.[0];
  const waitingReason = primaryContainerStatus?.state?.waiting?.reason;
  const lastExitCode = primaryContainerStatus?.lastState?.terminated?.exitCode;
  const isCrashLoop = waitingReason === "CrashLoopBackOff" || waitingReason === "Error";
  const isCrashedOnce = !isCrashLoop
    && typeof lastExitCode === "number" && lastExitCode !== 0
    && (deployment.status?.readyReplicas ?? 0) === 0
    && (deployment.spec?.replicas ?? 0) > 0;
  // Whether the server should auto-restart after a crash (default: true).
  const restartOnCrash = deployment.metadata?.annotations?.["infraweaver/restart-on-crash"] !== "false";

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
  const dnsHostname = deployment.metadata?.annotations?.["infraweaver.io/dns-hostname"] ?? service?.metadata?.annotations?.["external-dns.alpha.kubernetes.io/hostname"] ?? undefined;
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
  const joinPasswordSet = !!container?.env?.find((entry) => entry.name === "SERVER_PASSWORD")?.value;
  const commandBlocklist = parseStringArrayAnnotation(deployment.metadata?.annotations?.["game-hub/command-blocklist"]);
  const announcements = parseAnnouncementsAnnotation(deployment.metadata?.annotations?.["game-hub/announcements"]);
  const restartReason = deployment.metadata?.annotations?.["game-hub/restart-reason"] ?? null;
  const restartReasonTime = deployment.metadata?.annotations?.["game-hub/restart-time"] ?? null;
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
        : isCrashLoop
          ? "crash-loop"
          : isCrashedOnce
            ? "crashed"
            : hasInstallingInitContainer
              ? "installing"
              : (deployment.status?.replicas ?? 0) > 0
                ? "starting"
                : "stopped";

  // When restart-on-crash is disabled and the server is crash-looping, auto-stop it.
  // Runs as a side-effect of status polling so the UI catches it within one poll interval.
  if (!restartOnCrash && (status === "crash-loop" || status === "crashed")) {
    const crashAnnotation = deployment.metadata?.annotations?.["infraweaver/crash-stopped-at"];
    if (!crashAnnotation) {
      const webhookConfig = parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);
      void sendDiscordWebhook(webhookConfig, "crash", `💥 **${name}** crashed — auto-stopping (restart-on-crash disabled)`);
      void appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: { annotations: { "infraweaver/crash-stopped-at": new Date().toISOString() } },
          spec: { replicas: 0 },
        },
        fieldManager: "infraweaver",
      });
    }
  }

  // When restart-on-crash is enabled, still send a Discord notification so operators are aware.
  // Debounced via "last-crash-notified-count" annotation to avoid flooding on repeated polls.
  if (restartOnCrash && restartCount > 0 && (status === "crash-loop" || status === "crashed")) {
    const lastNotified = parseInt(
      deployment.metadata?.annotations?.["infraweaver/last-crash-notified-count"] ?? "0",
      10,
    );
    if (restartCount > lastNotified) {
      const webhookConfig = parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);
      void sendDiscordWebhook(
        webhookConfig,
        "crash",
        `⚠️ **${name}** crashed (restart #${restartCount}) — server is auto-restarting`,
      );
      void appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/last-crash-notified-count": String(restartCount) } } },
        fieldManager: "infraweaver",
      });
    }
  }

  // Auto-pause: when the server has been empty (0 players) for longer than configured threshold,
  // scale to 0. The players route updates "players-empty-since" — this block acts on it.
  const autoPauseEnabled = deployment.metadata?.annotations?.["infraweaver/autopause-enabled"] === "true";
  if (autoPauseEnabled && status === "running") {
    const autoPauseMinutes = parseInt(
      deployment.metadata?.annotations?.["infraweaver/autopause-minutes"] ?? "30",
      10,
    );
    const playersEmptySince = deployment.metadata?.annotations?.["infraweaver/players-empty-since"];
    const pauseStoppedAt = deployment.metadata?.annotations?.["infraweaver/autopause-stopped-at"];
    if (playersEmptySince && !pauseStoppedAt) {
      const emptyMs = Date.now() - new Date(playersEmptySince).getTime();
      const emptyMinutes = emptyMs / 60_000;
      if (emptyMinutes >= autoPauseMinutes) {
        const webhookConfig = parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);
        void sendDiscordWebhook(
          webhookConfig,
          "info",
          `💤 **${name}** auto-paused — no players for ${Math.floor(emptyMinutes)} minutes`,
        );
        void appsApi.patchNamespacedDeployment({
          name,
          namespace: GAME_HUB_NAMESPACE,
          body: {
            metadata: { annotations: { "infraweaver/autopause-stopped-at": new Date().toISOString() } },
            spec: { replicas: 0 },
          },
          fieldManager: "infraweaver",
        });
      }
    }
  }

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
    dnsHostname,
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
    restartOnCrash,
    restartPolicy: deployment.spec?.template?.spec?.restartPolicy ?? "Always",
    installerContainer: hasInstallingInitContainer ? (activeInitContainer?.name ?? null) : null,
    autoPauseEnabled: deployment.metadata?.annotations?.["infraweaver/autopause-enabled"] === "true",
    autoPauseMinutes: parseInt(deployment.metadata?.annotations?.["infraweaver/autopause-minutes"] ?? "30", 10),
    playersEmptySince: deployment.metadata?.annotations?.["infraweaver/players-empty-since"] ?? null,
    memory: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.memory ?? egg.defaultMemory ?? "",
    cpu: deployment.spec?.template?.spec?.containers?.[0]?.resources?.limits?.cpu ?? egg.defaultCpu ?? "",
    notes: deployment.metadata?.annotations?.["infraweaver/notes"] ?? "",
    annotations: deployment.metadata?.annotations ?? {},
    env: (deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => ({ name: entry.name, value: entry.value ?? undefined })),
    joinPasswordSet,
    commandBlocklist,
    announcements,
    restartReason,
    restartReasonTime,
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
    scheduleStart: parsePowerSchedule(deployment.metadata?.annotations?.["infraweaver.io/schedule-start"]),
    scheduleStop: parsePowerSchedule(deployment.metadata?.annotations?.["infraweaver.io/schedule-stop"]),
    alertCpu:
      deployment.metadata?.annotations?.["infraweaver.io/alert-cpu"] !== undefined &&
      deployment.metadata?.annotations?.["infraweaver.io/alert-cpu"] !== ""
        ? Number.parseInt(
            deployment.metadata?.annotations?.["infraweaver.io/alert-cpu"] ?? "0",
            10,
          )
        : null,
    alertMemory:
      deployment.metadata?.annotations?.["infraweaver.io/alert-memory"] !== undefined &&
      deployment.metadata?.annotations?.["infraweaver.io/alert-memory"] !== ""
        ? Number.parseInt(
            deployment.metadata?.annotations?.["infraweaver.io/alert-memory"] ?? "0",
            10,
          )
        : null,
    alertRestarts:
      deployment.metadata?.annotations?.["infraweaver.io/alert-restarts"] !== undefined &&
      deployment.metadata?.annotations?.["infraweaver.io/alert-restarts"] !== ""
        ? Number.parseInt(
            deployment.metadata?.annotations?.["infraweaver.io/alert-restarts"] ?? "0",
            10,
          )
        : null,
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
      canRead: perms.has("*") || perms.has("game-hub:read"),
      canPlayers: perms.has("*") || perms.has("game-hub:players"),
      canConsole: perms.has("*") || perms.has("game-hub:console") || allowedCommands.length > 0,
      canOpenConsole: perms.has("*") || perms.has("game-hub:console"),
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
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const token = req.nextUrl.searchParams.get("token");

  if (token) {
    try {
      const { coreApi } = makeGameHubClients();
      const valid = await validateServerToken(coreApi, name, token);
      if (!valid) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      return NextResponse.json(await buildResponse(name, true));
    } catch (error) {
      console.error("token auth server get failed", error);
      if (isKubernetesNotFoundError(error)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
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
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
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
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // ── IaC write-back: remove manifest from git FIRST ────────────────────────
    // CRITICAL: must run before deleting k8s resources. ArgoCD has selfHeal:true,
    // so if we delete k8s resources first, ArgoCD immediately re-creates them from
    // the git manifest. By deleting the manifest first, ArgoCD's desired state
    // becomes "nothing here" → it won't re-create anything after k8s deletion.
    const { token } = getGitHubConfig();
    if (!token.trim()) {
      return NextResponse.json({
        error: "Git token not configured - cannot safely delete server. Manifests would remain in git and ArgoCD would recreate the server.",
      }, { status: 500 });
    }
    await deleteServerManifest(name);

    const { appsApi, batchApi, coreApi } = makeGameHubClients();
    await appsApi.deleteNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedService({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedConfigMap({ name: `gameserver-${name}-audit`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await coreApi.deleteNamespacedSecret({ name: `gameserver-${name}-tokens`, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await deleteCronJob(batchApi, `gameserver-${name}-restart`);
    await deleteCronJob(batchApi, `gameserver-${name}-backup`);
    await deleteCronJob(batchApi, `gameserver-${name}-scheduled-start`);
    await deleteCronJob(batchApi, `gameserver-${name}-scheduled-stop`);

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
  const nameErr3 = validateK8sName(name);
  if (nameErr3) return NextResponse.json(nameErr3.error, { status: nameErr3.status });

  const rawBody = await req.json().catch(() => ({}));
  const actionParsed = patchActionSchema.safeParse(rawBody);
  if (!actionParsed.success) {
    return NextResponse.json({ error: "Validation failed", details: actionParsed.error.flatten() }, { status: 400 });
  }
  const body = rawBody as {
    action: "start" | "stop" | "force-stop" | "restart" | "scale" | "set-hpa" | "remove-hpa" | "update-env" | "set-restart-policy" | "set-autopause" | "set-notes" | "update-notes" | "update-resources" | "set-maintenance" | "set-schedule" | "set-backup-schedule" | "set-backup-target" | "set-alert-thresholds" | "expand-pvc" | "update-image" | "pin-image-version" | "unpin-image-version" | "update-pull-policy" | "update-strategy" | "update-identity" | "update-tags" | "update-service-ports" | "set-scheduled-action" | "set-join-password" | "set-command-blocklist" | "add-announcement" | "set-restart-reason" | "save-command" | "delete-saved-command" | "sync-to-git";
    replicas?: number;
    hpaMin?: number;
    hpaMax?: number;
    hpaCpuTarget?: number;
    env?: Record<string, string>;
    replaceEnv?: boolean;
    restartPolicy?: boolean;
    notes?: string;
    memory?: string;
    cpu?: string;
    enabled?: boolean;
    cronExpr?: string | null;
    startSchedule?: import("@/lib/game-hub-server").PowerSchedule | null;
    stopSchedule?: import("@/lib/game-hub-server").PowerSchedule | null;
    retention?: number;
    alertCpu?: number;
    alertMemory?: number;
    alertRestarts?: number;
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
    annotations?: Record<string, string>;
    reason?: string;
    password?: string | null;
    blocklist?: string[];
    schedule?: string;
    message?: string;
    ports?: Array<{ name: string; port: number; targetPort?: number; protocol?: "TCP" | "UDP"; nodePort?: number }>;
    scheduledAction?: string | null;
    scheduledTime?: string | null;
    command?: { id?: string; label: string; cmd: string; color?: string; description?: string };
    commandId?: string;
    commandLabel?: string;
    commandCmd?: string;
    autoPauseEnabled?: boolean;
    autoPauseMinutes?: number;
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
    let actionResult: Record<string, unknown> = {};

    if (body.action === "start") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        // Clear crash-stopped-at so auto-stop can fire again on the next crash.
        body: { spec: { replicas: 1 }, metadata: { annotations: { "infraweaver.io/last-started": new Date().toISOString(), "infraweaver/crash-stopped-at": "", "infraweaver/autopause-stopped-at": "", "infraweaver/players-empty-since": "" } } },

        fieldManager: "infraweaver",
      });
      await sendDiscordWebhook(webhookConfig, "start", `🟢 ${name} started`);
    } else if (body.action === "stop") {
      const result = await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped${result.exitedGracefully ? " gracefully" : ""}`);
    } else if (body.action === "force-stop") {
      await forceStopServer(clients, name);
      await sendDiscordWebhook(webhookConfig, "stop", `🛑 ${name} force-stopped`);
    } else if (body.action === "restart") {
      const pods = await clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
      for (const pod of pods.items ?? []) {
        await clients.coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
      }
      await sendDiscordWebhook(webhookConfig, "restart", `🔄 ${name} restarted`);
    } else if (body.action === "scale") {
      await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
      const count = Math.max(0, Math.min(body.replicas ?? 1, 10));
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: count } }, fieldManager: "infraweaver" });
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
        await clients.autoscalingApi.patchNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE, body: hpaSpec,  fieldManager: "infraweaver" });
      } catch {
        await clients.autoscalingApi.createNamespacedHorizontalPodAutoscaler({ namespace: GAME_HUB_NAMESPACE, body: hpaSpec });
      }
    } else if (body.action === "remove-hpa") {
      await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    } else if (body.action === "update-env") {
      const currentEnv = Object.fromEntries((deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => [entry.name, entry.value ?? ""]));
      const nextEnv = body.replaceEnv ? (body.env ?? {}) : { ...currentEnv, ...(body.env ?? {}) };
      const envVars = Object.entries(nextEnv).map(([key, value]) => ({ name: key, value }));
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, env: envVars }] } } } },

        fieldManager: "infraweaver",
      });
      await upsertEggConfigMap(clients.coreApi, name, egg, nextEnv);
    } else if (body.action === "set-restart-policy") {
      // Store the restart-on-crash preference as an annotation.
      // When false: the status poller auto-scales to 0 on crash detection.
      // When true (default): Kubernetes naturally restarts crashed containers.
      const enabled = body.restartPolicy !== false;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              "infraweaver/restart-on-crash": enabled ? "true" : "false",
              // Clear the crash-stopped marker when re-enabling so auto-stop can fire again next crash.
              ...(enabled ? {} : { "infraweaver/crash-stopped-at": "" }),
            },
          },
        },
        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-autopause") {
      // Configure auto-pause: scale to 0 when no players are detected for N minutes.
      // The players GET route tracks "players-empty-since"; this poller acts on it.
      const enabled = body.autoPauseEnabled !== false;
      const minutes = Math.max(5, Math.min(720, body.autoPauseMinutes ?? 30));
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              "infraweaver/autopause-enabled": enabled ? "true" : "false",
              "infraweaver/autopause-minutes": String(minutes),
              // Clear any stale pause marker so the next empty period is tracked fresh.
              "infraweaver/autopause-stopped-at": "",
            },
          },
        },
        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-notes" || body.action === "update-notes") {
      await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { metadata: { annotations: { "infraweaver/notes": body.notes ?? "" } } }, fieldManager: "infraweaver" });
    } else if (body.action === "update-resources") {
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, resources: { limits: { memory: body.memory, cpu: body.cpu }, requests: { memory: body.memory, cpu: body.cpu } } }] } } } },

        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-maintenance") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/maintenance": body.enabled ? "true" : "false" } } },
        fieldManager: "infraweaver",

      });
    } else if (body.action === "set-schedule") {
      const startSchedule = parsePowerSchedule(body.startSchedule);
      const stopSchedule = parsePowerSchedule(body.stopSchedule);
      await deleteCronJob(clients.batchApi, `gameserver-${name}-restart`);
      if (startSchedule) {
        await createCronJob(
          clients.batchApi,
          `gameserver-${name}-scheduled-start`,
          buildPowerScheduleCron(startSchedule),
          `kubectl scale deployment/${name} -n ${GAME_HUB_NAMESPACE} --replicas=1`,
          { app: name, "infraweaver/game": "true", "infraweaver/type": "scheduled-start" },
          startSchedule.timezone,
        );
      } else {
        await deleteCronJob(clients.batchApi, `gameserver-${name}-scheduled-start`);
      }
      if (stopSchedule) {
        await createCronJob(
          clients.batchApi,
          `gameserver-${name}-scheduled-stop`,
          buildPowerScheduleCron(stopSchedule),
          `kubectl scale deployment/${name} -n ${GAME_HUB_NAMESPACE} --replicas=0`,
          { app: name, "infraweaver/game": "true", "infraweaver/type": "scheduled-stop" },
          stopSchedule.timezone,
        );
      } else {
        await deleteCronJob(clients.batchApi, `gameserver-${name}-scheduled-stop`);
      }
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              "infraweaver.io/schedule-start": startSchedule ? JSON.stringify(startSchedule) : "",
              "infraweaver.io/schedule-stop": stopSchedule ? JSON.stringify(stopSchedule) : "",
              "infraweaver/restart-schedule": "",
            },
          },
        },
        fieldManager: "infraweaver",

      });
    } else if (body.action === "set-backup-schedule") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/backup-schedule": body.cronExpr ?? "", "infraweaver/backup-retention": String(body.retention ?? 7) } } },
        fieldManager: "infraweaver",

      });
    } else if (body.action === "set-backup-target") {
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations: { "infraweaver/backup-target": body.target ?? "local" } } },
        fieldManager: "infraweaver",

      });
    } else if (body.action === "set-alert-thresholds") {
      const alertCpu = Math.min(100, Math.max(0, Math.round(body.alertCpu ?? 80)));
      const alertMemory = Math.min(100, Math.max(0, Math.round(body.alertMemory ?? 80)));
      const alertRestarts = Math.min(20, Math.max(1, Math.round(body.alertRestarts ?? 5)));
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: {
            annotations: {
              "infraweaver.io/alert-cpu": String(alertCpu),
              "infraweaver.io/alert-memory": String(alertMemory),
              "infraweaver.io/alert-restarts": String(alertRestarts),
            },
          },
        },
        fieldManager: "infraweaver",

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

        fieldManager: "infraweaver",
      });
    } else if (body.action === "pin-image-version") {
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      const currentImage = deployment.spec?.template?.spec?.containers?.[0]?.image ?? egg.dockerImage;
      const currentVersion = deployment.metadata?.annotations?.["infraweaver.io/image-version"] ?? parseImageVersion(currentImage).version;
      if (!currentVersion || currentVersion === "unknown" || currentVersion === "latest" || currentVersion === "sha256") {
        return NextResponse.json({ error: "No concrete image version available to pin" }, { status: 400 });
      }
      const pinnedImage = replaceImageTag(currentImage, currentVersion);
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: { annotations: { "infraweaver.io/image-version": currentVersion } },
          spec: { template: { metadata: { annotations: { "infraweaver.io/image-version": currentVersion } }, spec: { containers: [{ name: containerName, image: pinnedImage }] } } },
        },

        fieldManager: "infraweaver",
      });
    } else if (body.action === "unpin-image-version") {
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      const currentImage = deployment.spec?.template?.spec?.containers?.[0]?.image ?? egg.dockerImage;
      const latestImage = replaceImageTag(currentImage, "latest");
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: {
          metadata: { annotations: { "infraweaver.io/image-version": "latest" } },
          spec: { template: { metadata: { annotations: { "infraweaver.io/image-version": "latest" } }, spec: { containers: [{ name: containerName, image: latestImage }] } } },
        },

        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-pull-policy") {
      if (!body.pullPolicy) return NextResponse.json({ error: "pullPolicy is required" }, { status: 400 });
      const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { template: { spec: { containers: [{ name: containerName, imagePullPolicy: body.pullPolicy }] } } } },

        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-strategy") {
      const strategyType = body.strategy === "Recreate" ? "Recreate" : "RollingUpdate";
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { spec: { strategy: { type: strategyType } } },

        fieldManager: "infraweaver",
      });
    } else if (body.action === "update-identity" || body.action === "update-tags") {
      const annotations: Record<string, string> = {};
      if (body.description !== undefined) annotations["infraweaver.io/description"] = body.description;
      if (body.icon !== undefined) annotations["infraweaver.io/icon"] = body.icon;
      if (body.tags !== undefined) annotations["infraweaver.io/tags"] = (body.tags ?? []).join(",");
      if (body.groups !== undefined) annotations["infraweaver.io/groups"] = (body.groups ?? []).join(",");
      Object.assign(annotations, body.annotations ?? {});
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NAMESPACE,
        body: { metadata: { annotations } },

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
 
        fieldManager: "infraweaver",
      });
    } else if (body.action === "set-join-password") {
      const password = typeof body.password === "string" ? body.password : null;
      const deploy = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
      const containers = deploy.spec?.template?.spec?.containers ?? [];
      const primaryContainer = containers[0];
      if (!primaryContainer) {
        return NextResponse.json({ error: "Server container not found" }, { status: 404 });
      }
      const envVars = primaryContainer.env ?? [];
      const filtered = envVars.filter((entry) => entry.name !== "SERVER_PASSWORD");
      if (password) filtered.push({ name: "SERVER_PASSWORD", value: password });
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NS,
        body: { spec: { template: { spec: { containers: [{ ...primaryContainer, env: filtered }] } } } },
      });
      actionResult = { ok: true, passwordSet: !!password };
    } else if (body.action === "set-command-blocklist") {
      const blocklist = Array.isArray(body.blocklist)
        ? body.blocklist.filter((entry): entry is string => typeof entry === "string")
        : [];
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "game-hub/command-blocklist": JSON.stringify(blocklist) } } },
      });
      actionResult = { ok: true, blocklist };
    } else if (body.action === "add-announcement") {
      const schedule = typeof body.schedule === "string" ? body.schedule : null;
      const message = typeof body.message === "string" ? body.message.slice(0, 200) : null;
      if (!schedule || !message) {
        return NextResponse.json({ error: "schedule and message required" }, { status: 400 });
      }
      const deploy = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
      const existing = parseAnnouncementsAnnotation(deploy.metadata?.annotations?.["game-hub/announcements"]);
      const announcements = [...existing, { id: Date.now().toString(), schedule, message }].slice(-10);
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "game-hub/announcements": JSON.stringify(announcements) } } },
      });
      actionResult = { ok: true, announcements };
    } else if (body.action === "set-restart-reason") {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 100) : "manual";
      const validReasons = ["manual", "crash", "oom", "maintenance", "scheduled", "update"];
      const safeReason = validReasons.includes(reason) ? reason : "manual";
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "game-hub/restart-reason": safeReason, "game-hub/restart-time": new Date().toISOString() } } },
      });
      actionResult = { ok: true, reason: safeReason };
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
      const existing = await readSavedCommands(clients.coreApi, name);
      let updated: typeof existing;
      if (body.commandId) {
        updated = existing.filter((c) => c.id !== body.commandId);
      } else if (body.commandLabel !== undefined || body.commandCmd !== undefined) {
        // Legacy commands stored without IDs — match by label + cmd
        updated = existing.filter(
          (c) => !(c.label === body.commandLabel && c.cmd === body.commandCmd),
        );
      } else {
        return NextResponse.json({ error: "commandId or commandLabel+commandCmd is required" }, { status: 400 });
      }
      await writeSavedCommands(clients.coreApi, name, updated);
    } else if (body.action === "sync-to-git") {
      // Manifest sync is handled below.
    }

    await auditLog(`game-hub:${body.action}`, session.user?.email ?? "unknown", `${body.action} ${name}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: body.action, details: JSON.stringify(body) });

    // ── IaC write-back ────────────────────────────────────────────────────────
    // Power actions (start/stop/force-stop/scale) and config actions are synced
    // to git so ArgoCD's selfHeal does not revert them. Purely transient actions
    // (restart/set-maintenance/set-notes) are excluded — they don't change the
    // git-tracked desired state.
    //
    // The git write happens in `after()` — NOT inline — for two reasons that were
    // the actual bug behind "stop doesn't stick" (feedback df5a9e3b):
    //   1. writeServerManifest does multiple GitHub round-trips (read SHA + commit).
    //      Awaiting it inline made the request slow enough that the browser/proxy
    //      dropped the connection → bare `TypeError: Load failed` on Stop.
    //   2. When that request was torn down, the in-flight git write never finished,
    //      so git still said `replicas: 1` and ArgoCD selfHeal scaled the server
    //      back up → it "auto-started" right after Stop.
    // `after()` runs once the response has been sent, independent of the client
    // connection, so the in-cluster change (already applied synchronously above)
    // reliably gets persisted to git and ArgoCD respects the stopped state.
    if (MANIFEST_SYNC_ACTIONS.has(body.action)) {
      const syncAction = body.action;
      after(async () => {
        try {
          await writeServerManifest(name, clients);
        } catch (gitErr) {
          console.error(`writeServerManifest failed for action ${syncAction} on ${name}:`, gitErr);
        }
      });
    }

    return NextResponse.json({ action: body.action, name, ...actionResult });
  } catch (error) {
    console.error("server patch failed", error);
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
