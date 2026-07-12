import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { z } from "zod";
import { logMutatingAccess } from "@/lib/access-log";
import { buildEggConfigMap, type GameEgg } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import {
  buildPowerScheduleCron,
  createCronJob,
  deleteCronJob,
  forceStopServer,
  GAME_HUB_NS,
  gracefulStopServer,
  parseImageVersion,
  parsePowerSchedule,
  readSavedCommands,
  restartServerPods,
  sendDiscordWebhook,
  upsertConfigMap,
  waitForVolumeReleased,
  writeSavedCommands,
  type DiscordWebhookConfig,
  type GameHubClients,
} from "@/lib/game-hub-server";
import type { Permission } from "@/lib/rbac";

export const VALID_ACTIONS = [
  "start", "stop", "force-stop", "restart", "scale", "set-hpa", "remove-hpa", "update-env",
  "set-restart-policy", "set-autopause", "set-notes", "update-notes", "update-resources", "set-maintenance",
  "set-schedule", "set-backup-schedule", "set-backup-target", "set-alert-thresholds",
  "expand-pvc", "update-image", "pin-image-version", "unpin-image-version",
  "update-pull-policy", "update-strategy", "update-identity", "update-tags",
  "update-service-ports", "set-scheduled-action", "save-command", "delete-saved-command",
  "set-join-password", "set-command-blocklist", "add-announcement", "set-restart-reason",
  "sync-to-git",
] as const;

export type ServerPatchAction = (typeof VALID_ACTIONS)[number];

/**
 * Full PATCH request schema (replaces the old hand-written cast of the raw
 * body). Every field except `action` is optional; the per-action handlers keep
 * their own required-field checks so error messages stay identical.
 */
export const serverPatchBodySchema = z.object({
  action: z.enum(VALID_ACTIONS),
  replicas: z.number().optional(),
  hpaMin: z.number().optional(),
  hpaMax: z.number().optional(),
  hpaCpuTarget: z.number().optional(),
  env: z.record(z.string(), z.string()).optional(),
  replaceEnv: z.boolean().optional(),
  restartPolicy: z.boolean().optional(),
  notes: z.string().optional(),
  memory: z.string().optional(),
  cpu: z.string().optional(),
  enabled: z.boolean().optional(),
  cronExpr: z.string().nullish(),
  // parsePowerSchedule accepts either a JSON string or an object and normalizes
  // both, so these stay unconstrained on purpose.
  startSchedule: z.unknown().optional(),
  stopSchedule: z.unknown().optional(),
  retention: z.number().optional(),
  alertCpu: z.number().optional(),
  alertMemory: z.number().optional(),
  alertRestarts: z.number().optional(),
  target: z.string().optional(),
  pvcName: z.string().optional(),
  newSize: z.string().optional(),
  image: z.string().optional(),
  pullPolicy: z.enum(["Always", "IfNotPresent", "Never"]).optional(),
  strategy: z.enum(["RollingUpdate", "Recreate"]).optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  groups: z.array(z.string()).optional(),
  annotations: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional(),
  password: z.string().nullish(),
  blocklist: z.array(z.string()).optional(),
  schedule: z.string().optional(),
  message: z.string().optional(),
  ports: z.array(z.object({
    name: z.string(),
    port: z.number(),
    targetPort: z.number().optional(),
    protocol: z.enum(["TCP", "UDP"]).optional(),
    nodePort: z.number().optional(),
  })).optional(),
  scheduledAction: z.string().nullish(),
  scheduledTime: z.string().nullish(),
  command: z.object({
    id: z.string().optional(),
    label: z.string(),
    cmd: z.string(),
    color: z.string().optional(),
    description: z.string().optional(),
  }).optional(),
  commandId: z.string().optional(),
  commandLabel: z.string().optional(),
  commandCmd: z.string().optional(),
  autoPauseEnabled: z.boolean().optional(),
  autoPauseMinutes: z.number().optional(),
});

export type ServerPatchBody = z.infer<typeof serverPatchBodySchema>;

/** Per-action permission required to run it (checked against the server scope). */
export const ACTION_PERMISSIONS: Record<ServerPatchAction, Permission> = {
  start: "game-hub:start",
  stop: "game-hub:stop",
  "force-stop": "game-hub:stop",
  scale: "game-hub:scale",
  "sync-to-git": "game-hub:admin",
  "set-hpa": "game-hub:admin",
  "remove-hpa": "game-hub:admin",
  "update-env": "game-hub:admin",
  "set-restart-policy": "game-hub:admin",
  "set-notes": "game-hub:admin",
  "update-notes": "game-hub:admin",
  "update-resources": "game-hub:admin",
  "set-maintenance": "game-hub:admin",
  "set-schedule": "game-hub:admin",
  "set-backup-schedule": "game-hub:admin",
  "set-backup-target": "game-hub:admin",
  "set-alert-thresholds": "game-hub:admin",
  "expand-pvc": "game-hub:admin",
  "update-image": "game-hub:admin",
  "pin-image-version": "game-hub:admin",
  "unpin-image-version": "game-hub:admin",
  "update-pull-policy": "game-hub:admin",
  "update-strategy": "game-hub:admin",
  "update-identity": "game-hub:admin",
  "update-tags": "game-hub:admin",
  "update-service-ports": "game-hub:admin",
  "set-scheduled-action": "game-hub:admin",
  "save-command": "game-hub:admin",
  "delete-saved-command": "game-hub:admin",
  restart: "game-hub:write",
  "set-autopause": "game-hub:write",
  "set-join-password": "game-hub:write",
  "set-command-blocklist": "game-hub:write",
  "add-announcement": "game-hub:write",
  "set-restart-reason": "game-hub:write",
};

export type ServerAnnouncement = {
  id: string;
  schedule: string;
  message: string;
};

export function parseStringArrayAnnotation(raw: string | undefined) {
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

export function parseAnnouncementsAnnotation(raw: string | undefined) {
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

function replaceImageTag(image: string, nextTag: string) {
  const base = image.includes("@") ? image.split("@")[0] ?? image : image;
  const lastColon = base.lastIndexOf(":");
  const lastSlash = base.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return `${base.slice(0, lastColon)}:${nextTag}`;
  }
  return `${base}:${nextTag}`;
}

/**
 * All deployment PATCHes go out as strategic-merge-patch, which merges the `env`
 * list by `name` and NEVER deletes entries. So removing an env var (a full env
 * replace, or clearing a join password) silently no-ops — the old value persists
 * while the UI reports it gone. Prepending the strategic-merge `$patch: replace`
 * directive forces the API server to replace the entire env list, so removed vars
 * are actually deleted.
 */
function envListReplacingAll(
  envVars: Array<{ name: string; value?: string }>,
): Array<{ name: string; value?: string }> {
  return [{ $patch: "replace" }, ...envVars] as unknown as Array<{ name: string; value?: string }>;
}

/** Strategic-merge patch of deployment annotations only. */
async function patchServerAnnotations(
  clients: GameHubClients,
  name: string,
  annotations: Record<string, string>,
  opts: { fieldManager?: boolean } = {},
) {
  await clients.appsApi.patchNamespacedDeployment({
    name,
    namespace: GAME_HUB_NAMESPACE,
    body: { metadata: { annotations } },
    ...(opts.fieldManager === false ? {} : { fieldManager: "infraweaver" }),
  });
}

export interface ServerActionContext {
  req: NextRequest;
  session: Session;
  name: string;
  body: ServerPatchBody;
  clients: GameHubClients;
  deployment: Awaited<ReturnType<GameHubClients["appsApi"]["readNamespacedDeployment"]>>;
  egg: GameEgg;
  webhookConfig: DiscordWebhookConfig | null;
}

/**
 * Handler outcome: `response` short-circuits the request (validation error —
 * skips audit + manifest sync, matching the old inline early returns);
 * `result` is merged into the success envelope.
 */
export interface ServerActionOutcome {
  result?: Record<string, unknown>;
  response?: NextResponse;
}

type ServerActionHandler = (ctx: ServerActionContext) => Promise<ServerActionOutcome>;

const setNotes: ServerActionHandler = async ({ clients, name, body }) => {
  await patchServerAnnotations(clients, name, { "infraweaver/notes": body.notes ?? "" });
  return {};
};

const updateIdentity: ServerActionHandler = async ({ clients, name, body }) => {
  const annotations: Record<string, string> = {};
  if (body.description !== undefined) annotations["infraweaver.io/description"] = body.description;
  if (body.icon !== undefined) annotations["infraweaver.io/icon"] = body.icon;
  if (body.tags !== undefined) annotations["infraweaver.io/tags"] = (body.tags ?? []).join(",");
  if (body.groups !== undefined) annotations["infraweaver.io/groups"] = (body.groups ?? []).join(",");
  Object.assign(annotations, body.annotations ?? {});
  await patchServerAnnotations(clients, name, annotations);
  return {};
};

export const serverActionHandlers: Record<ServerPatchAction, ServerActionHandler> = {
  start: async ({ clients, name, webhookConfig }) => {
    // A ReadWriteOnce PVC stays attached to the old pod until it fully
    // terminates. If start races a just-issued stop, scaling to 1 now would
    // schedule the new pod while the old one still holds the volume →
    // Multi-Attach churn. Wait for the terminating pod (and its volume) to be
    // released first; bounded, so a stalled termination still lets start through.
    await waitForVolumeReleased(clients.coreApi, name);
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      // Clear crash-stopped-at so auto-stop can fire again on the next crash.
      body: { spec: { replicas: 1 }, metadata: { annotations: { "infraweaver.io/last-started": new Date().toISOString(), "infraweaver/crash-stopped-at": "", "infraweaver/autopause-stopped-at": "", "infraweaver/players-empty-since": "" } } },

      fieldManager: "infraweaver",
    });
    await sendDiscordWebhook(webhookConfig, "start", `🟢 ${name} started`);
    return {};
  },

  stop: async ({ clients, name, egg, webhookConfig }) => {
    // Delete any HPA first: an HPA with minReplicas >= 1 immediately scales the
    // deployment back up after we scale to 0, causing the reported
    // stopped -> starting -> running auto-restart. Matches the scale action.
    await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    const result = await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
    await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped${result.exitedGracefully ? " gracefully" : ""}`);
    return {};
  },

  "force-stop": async ({ clients, name, webhookConfig }) => {
    // See stop: remove the HPA so it cannot re-scale the pod back from 0.
    await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    await forceStopServer(clients, name);
    await sendDiscordWebhook(webhookConfig, "stop", `🛑 ${name} force-stopped`);
    return {};
  },

  restart: async ({ req, session, clients, name, webhookConfig }) => {
    // Never delete a pod mid-install: the Recreate-strategy Deployment would
    // recreate it and re-run the whole install, so a restart repeated during a
    // console rolling update churns the pod for the install's whole duration.
    //
    // Emit a raw `type:access` line for the same reason the generic /api/pods
    // routes do: a game-hub-originated restart deletes pods, so when it churns
    // an installing pod during a console rolling update the trail must pin the
    // caller + referer (this route's restart was previously the one mutating
    // path with no access line).
    logMutatingAccess(req, session.user?.email ?? "unknown");
    const { deleted, skippedInstalling } = await restartServerPods(clients, name);
    await sendDiscordWebhook(webhookConfig, "restart", `🔄 ${name} restarted`);
    return { result: { restarted: deleted, skippedInstalling } };
  },

  scale: async ({ clients, name, body }) => {
    await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    const count = Math.max(0, Math.min(body.replicas ?? 1, 10));
    await clients.appsApi.patchNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE, body: { spec: { replicas: count } }, fieldManager: "infraweaver" });
    return {};
  },

  "set-hpa": async ({ clients, name, body }) => {
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
    return {};
  },

  "remove-hpa": async ({ clients, name }) => {
    await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);
    return {};
  },

  "update-env": async ({ clients, name, body, deployment, egg }) => {
    const currentEnv = Object.fromEntries((deployment.spec?.template?.spec?.containers?.[0]?.env ?? []).map((entry) => [entry.name, entry.value ?? ""]));
    const nextEnv = body.replaceEnv ? (body.env ?? {}) : { ...currentEnv, ...(body.env ?? {}) };
    const envVars = Object.entries(nextEnv).map(([key, value]) => ({ name: key, value }));
    const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
    // A full replace must actually DELETE vars the caller dropped; strategic
    // merge alone would keep them. Merge mode intentionally upserts by name.
    const envForPatch = body.replaceEnv ? envListReplacingAll(envVars) : envVars;
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { template: { spec: { containers: [{ name: containerName, env: envForPatch }] } } } },

      fieldManager: "infraweaver",
    });
    await upsertConfigMap(clients.coreApi, buildEggConfigMap(GAME_HUB_NAMESPACE, name, egg, nextEnv), GAME_HUB_NAMESPACE);
    return {};
  },

  "set-restart-policy": async ({ clients, name, body }) => {
    // Store the restart-on-crash preference as an annotation.
    // When false: the status poller auto-scales to 0 on crash detection.
    // When true (default): Kubernetes naturally restarts crashed containers.
    const enabled = body.restartPolicy !== false;
    await patchServerAnnotations(clients, name, {
      "infraweaver/restart-on-crash": enabled ? "true" : "false",
      // Clear the crash-stopped marker when re-enabling so auto-stop can fire again next crash.
      ...(enabled ? {} : { "infraweaver/crash-stopped-at": "" }),
    });
    return {};
  },

  "set-autopause": async ({ clients, name, body }) => {
    // Configure auto-pause: scale to 0 when no players are detected for N minutes.
    // The players GET route tracks "players-empty-since"; this poller acts on it.
    const enabled = body.autoPauseEnabled !== false;
    const minutes = Math.max(5, Math.min(720, body.autoPauseMinutes ?? 30));
    await patchServerAnnotations(clients, name, {
      "infraweaver/autopause-enabled": enabled ? "true" : "false",
      "infraweaver/autopause-minutes": String(minutes),
      // Clear any stale pause marker so the next empty period is tracked fresh.
      "infraweaver/autopause-stopped-at": "",
    });
    return {};
  },

  "set-notes": setNotes,
  "update-notes": setNotes,

  "update-resources": async ({ clients, name, body, deployment }) => {
    const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { template: { spec: { containers: [{ name: containerName, resources: { limits: { memory: body.memory, cpu: body.cpu }, requests: { memory: body.memory, cpu: body.cpu } } }] } } } },

      fieldManager: "infraweaver",
    });
    return {};
  },

  "set-maintenance": async ({ clients, name, body }) => {
    await patchServerAnnotations(clients, name, { "infraweaver/maintenance": body.enabled ? "true" : "false" });
    return {};
  },

  "set-schedule": async ({ clients, name, body }) => {
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
    await patchServerAnnotations(clients, name, {
      "infraweaver.io/schedule-start": startSchedule ? JSON.stringify(startSchedule) : "",
      "infraweaver.io/schedule-stop": stopSchedule ? JSON.stringify(stopSchedule) : "",
      "infraweaver/restart-schedule": "",
    });
    return {};
  },

  "set-backup-schedule": async ({ clients, name, body }) => {
    await patchServerAnnotations(clients, name, { "infraweaver/backup-schedule": body.cronExpr ?? "", "infraweaver/backup-retention": String(body.retention ?? 7) });
    return {};
  },

  "set-backup-target": async ({ clients, name, body }) => {
    await patchServerAnnotations(clients, name, { "infraweaver/backup-target": body.target ?? "local" });
    return {};
  },

  "set-alert-thresholds": async ({ clients, name, body }) => {
    const alertCpu = Math.min(100, Math.max(0, Math.round(body.alertCpu ?? 80)));
    const alertMemory = Math.min(100, Math.max(0, Math.round(body.alertMemory ?? 80)));
    const alertRestarts = Math.min(20, Math.max(1, Math.round(body.alertRestarts ?? 5)));
    await patchServerAnnotations(clients, name, {
      "infraweaver.io/alert-cpu": String(alertCpu),
      "infraweaver.io/alert-memory": String(alertMemory),
      "infraweaver.io/alert-restarts": String(alertRestarts),
    });
    return {};
  },

  "expand-pvc": async ({ clients, body }) => {
    if (!body.pvcName || !body.newSize) {
      return { response: NextResponse.json({ error: "pvcName and newSize are required" }, { status: 400 }) };
    }
    await clients.coreApi.patchNamespacedPersistentVolumeClaim({
      name: body.pvcName,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { resources: { requests: { storage: body.newSize } } } },
      fieldManager: "infraweaver",

    });
    return {};
  },

  "update-image": async ({ clients, name, body, deployment }) => {
    if (!body.image) return { response: NextResponse.json({ error: "image is required" }, { status: 400 }) };
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
    return {};
  },

  "pin-image-version": async ({ clients, name, deployment, egg }) => {
    const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
    const currentImage = deployment.spec?.template?.spec?.containers?.[0]?.image ?? egg.dockerImage;
    const currentVersion = deployment.metadata?.annotations?.["infraweaver.io/image-version"] ?? parseImageVersion(currentImage).version;
    if (!currentVersion || currentVersion === "unknown" || currentVersion === "latest" || currentVersion === "sha256") {
      return { response: NextResponse.json({ error: "No concrete image version available to pin" }, { status: 400 }) };
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
    return {};
  },

  "unpin-image-version": async ({ clients, name, deployment, egg }) => {
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
    return {};
  },

  "update-pull-policy": async ({ clients, name, body, deployment }) => {
    if (!body.pullPolicy) return { response: NextResponse.json({ error: "pullPolicy is required" }, { status: 400 }) };
    const containerName = deployment.spec?.template?.spec?.containers?.[0]?.name ?? name;
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { template: { spec: { containers: [{ name: containerName, imagePullPolicy: body.pullPolicy }] } } } },

      fieldManager: "infraweaver",
    });
    return {};
  },

  "update-strategy": async ({ clients, name, body }) => {
    const strategyType = body.strategy === "Recreate" ? "Recreate" : "RollingUpdate";
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { strategy: { type: strategyType } } },

      fieldManager: "infraweaver",
    });
    return {};
  },

  "update-identity": updateIdentity,
  "update-tags": updateIdentity,

  "update-service-ports": async ({ clients, name, body }) => {
    if (!body.ports?.length) return { response: NextResponse.json({ error: "ports array is required" }, { status: 400 }) };
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
    return {};
  },

  "set-scheduled-action": async ({ clients, name, body }) => {
    await patchServerAnnotations(clients, name, {
      "infraweaver.io/scheduled-action": body.scheduledAction ?? "",
      "infraweaver.io/scheduled-time": body.scheduledTime ?? "",
    });
    return {};
  },

  "set-join-password": async ({ clients, name, body }) => {
    const password = typeof body.password === "string" ? body.password : null;
    const deploy = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
    const containers = deploy.spec?.template?.spec?.containers ?? [];
    const primaryContainer = containers[0];
    if (!primaryContainer) {
      return { response: NextResponse.json({ error: "Server container not found" }, { status: 404 }) };
    }
    const envVars = primaryContainer.env ?? [];
    const filtered = envVars.filter((entry) => entry.name !== "SERVER_PASSWORD");
    if (password) filtered.push({ name: "SERVER_PASSWORD", value: password });
    // Clearing the password must truly remove SERVER_PASSWORD; strategic merge
    // would otherwise retain the old value while we report it removed. Replace
    // the whole env list so the deletion actually takes effect.
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NS,
      body: { spec: { template: { spec: { containers: [{ ...primaryContainer, env: envListReplacingAll(filtered) }] } } } },
    });
    return { result: { ok: true, passwordSet: !!password } };
  },

  "set-command-blocklist": async ({ clients, name, body }) => {
    const blocklist = Array.isArray(body.blocklist)
      ? body.blocklist.filter((entry): entry is string => typeof entry === "string")
      : [];
    await patchServerAnnotations(clients, name, { "game-hub/command-blocklist": JSON.stringify(blocklist) }, { fieldManager: false });
    return { result: { ok: true, blocklist } };
  },

  "add-announcement": async ({ clients, name, body }) => {
    const schedule = typeof body.schedule === "string" ? body.schedule : null;
    const message = typeof body.message === "string" ? body.message.slice(0, 200) : null;
    if (!schedule || !message) {
      return { response: NextResponse.json({ error: "schedule and message required" }, { status: 400 }) };
    }
    const deploy = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
    const existing = parseAnnouncementsAnnotation(deploy.metadata?.annotations?.["game-hub/announcements"]);
    const announcements = [...existing, { id: Date.now().toString(), schedule, message }].slice(-10);
    await patchServerAnnotations(clients, name, { "game-hub/announcements": JSON.stringify(announcements) }, { fieldManager: false });
    return { result: { ok: true, announcements } };
  },

  "set-restart-reason": async ({ clients, name, body }) => {
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 100) : "manual";
    const validReasons = ["manual", "crash", "oom", "maintenance", "scheduled", "update"];
    const safeReason = validReasons.includes(reason) ? reason : "manual";
    await patchServerAnnotations(clients, name, { "game-hub/restart-reason": safeReason, "game-hub/restart-time": new Date().toISOString() }, { fieldManager: false });
    return { result: { ok: true, reason: safeReason } };
  },

  "save-command": async ({ clients, name, body }) => {
    if (!body.command?.label || !body.command?.cmd) return { response: NextResponse.json({ error: "command.label and command.cmd are required" }, { status: 400 }) };
    const existing = await readSavedCommands(clients.coreApi, name);
    const id = body.command.id ?? randomUUID();
    const filtered = existing.filter((c) => c.id !== id);
    await writeSavedCommands(clients.coreApi, name, [
      ...filtered,
      { id, label: body.command.label, cmd: body.command.cmd, color: body.command.color, description: body.command.description },
    ]);
    return {};
  },

  "delete-saved-command": async ({ clients, name, body }) => {
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
      return { response: NextResponse.json({ error: "commandId or commandLabel+commandCmd is required" }, { status: 400 }) };
    }
    await writeSavedCommands(clients.coreApi, name, updated);
    return {};
  },

  "sync-to-git": async () => ({}), // Manifest sync is handled by the route after the handler runs.
};
