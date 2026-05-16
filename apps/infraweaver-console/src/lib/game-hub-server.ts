import * as k8s from "@kubernetes/client-node";
import { randomBytes, randomUUID } from "crypto";
import net from "net";
import { Writable } from "stream";
import { getEggForGameType, type GameEgg, type SavedCommand } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, parseEggConfig } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";

export const GAME_HUB_NS = GAME_HUB_NAMESPACE;
const AUDIT_CONFIG_MAP_KEY = "entries.json";
const TOKENS_SECRET_KEY = "tokens.json";
const SAVED_COMMANDS_KEY = "saved-commands.json";
const COMMAND_RETRY_DELAY_MS = 2_000;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface ServerAuditEntry {
  timestamp: string;
  user: string;
  action: string;
  details: string;
}

export interface ServerTokenRecord {
  id: string;
  label: string;
  token: string;
  prefix: string;
  createdAt: string;
}

export interface PlayerHistoryPoint {
  t: number;
  n: number;
}

export interface DiscordWebhookConfig {
  url: string;
  events: string[];
}

export interface PowerSchedule {
  time: string;
  days: string[];
  timezone: string;
}

export function normalizeServerName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getDeploymentGameType(deployment: { metadata?: { labels?: Record<string, string> } } | null | undefined) {
  return deployment?.metadata?.labels?.["infraweaver/game-type"] ?? deployment?.metadata?.labels?.["infraweaver.io/game-type"] ?? "unknown";
}

export function parseImageVersion(image: string | null | undefined) {
  const value = (image ?? "").trim();
  if (!value) return { version: "unknown", pinned: false };
  if (value.includes("@sha256:")) return { version: "sha256", pinned: true };
  const lastColon = value.lastIndexOf(":");
  const lastSlash = value.lastIndexOf("/");
  if (lastColon > lastSlash) {
    const version = value.slice(lastColon + 1) || "latest";
    return { version, pinned: version.toLowerCase() !== "latest" };
  }
  return { version: "latest", pinned: false };
}

export function makeGameHubClients() {
  const kc = loadKubeConfig();
  return {
    kc,
    appsApi: kc.makeApiClient(k8s.AppsV1Api),
    autoscalingApi: kc.makeApiClient(k8s.AutoscalingV2Api),
    batchApi: kc.makeApiClient(k8s.BatchV1Api),
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
    customObjectsApi: kc.makeApiClient(k8s.CustomObjectsApi),
  };
}

export type GameHubClients = ReturnType<typeof makeGameHubClients>;

export async function readServerEgg(
  coreApi: k8s.CoreV1Api,
  name: string,
  deployment?: { metadata?: { labels?: Record<string, string> } },
): Promise<GameEgg> {
  try {
    const configMap = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NS });
    const raw = configMap.data?.["egg.json"];
    if (raw) return parseEggConfig(raw, getDeploymentGameType(deployment));
  } catch {
    // fall through to game type defaults
  }
  return getEggForGameType(getDeploymentGameType(deployment));
}

export async function getServerDeployment(appsApi: k8s.AppsV1Api, name: string) {
  return appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
}

export async function getServerPod(coreApi: k8s.CoreV1Api, name: string, runningOnly = false) {
  const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
  if (runningOnly) {
    const fullyRunning = pods.items.find((pod) => {
      if (pod.status?.phase !== "Running") return false;
      const containerStatuses = pod.status?.containerStatuses ?? [];
      if (containerStatuses.length === 0) return false;
      return containerStatuses.every((cs) => cs.state?.running != null);
    });
    return fullyRunning ?? null;
  }
  return pods.items.find((pod) => pod.status?.phase === "Running") ?? pods.items[0] ?? null;
}

export function getPrimaryContainerName(pod: k8s.V1Pod | null | undefined, fallback: string) {
  return pod?.spec?.containers?.[0]?.name ?? fallback;
}

function missingExecutable(error: unknown) {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("executable file not found") || message.includes("no such file or directory") || message.includes("not found");
}

export function splitExecCommand(command: string) {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote === char ? null : char;
      continue;
    }

    if (/\s/.test(char) && !quote) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new Error("Unterminated quoted string");
  if (escaped) throw new Error("Trailing escape in command");
  if (current) args.push(current);
  if (args.length === 0) throw new Error("command is required");
  return args;
}

export async function execInPod(
  kc: k8s.KubeConfig,
  podName: string,
  containerName: string,
  command: string[],
  timeoutMs = 15000,
): Promise<ExecResult> {
  const exec = new k8s.Exec(kc);
  let stdout = "";
  let stderr = "";
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => done(), timeoutMs);
    const stdoutStream = new Writable({ write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); } });
    const stderrStream = new Writable({ write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); } });

    exec.exec(GAME_HUB_NS, podName, containerName, command, stdoutStream, stderrStream, null, false, (status) => {
      if (status?.status === "Failure") done(new Error(status.message ?? "Exec failed"));
      else done();
    }).then((ws) => {
      ws.on("close", () => done());
      ws.on("error", (error: Error) => done(error));
    }).catch((error: Error) => done(error));
  });

  return { stdout, stderr };
}

export async function execShell(
  kc: k8s.KubeConfig,
  podName: string,
  containerName: string,
  script: string,
  timeoutMs = 15000,
) {
  return execInPod(kc, podName, containerName, ["sh", "-c", script], timeoutMs);
}

export async function execCommandText(
  kc: k8s.KubeConfig,
  podName: string,
  containerName: string,
  command: string,
  timeoutMs = 15000,
) {
  return execInPod(kc, podName, containerName, splitExecCommand(command), timeoutMs);
}

export async function runRconCommand(
  kc: k8s.KubeConfig,
  podName: string,
  containerName: string,
  command: string,
  timeoutMs = 15000,
) {
  const candidates = [
    ["/usr/local/bin/rcon-cli", command],
    ["/usr/bin/rcon-cli", command],
    ["rcon-cli", command],
  ];

  for (const candidate of candidates) {
    try {
      return await execInPod(kc, podName, containerName, candidate, timeoutMs);
    } catch (error) {
      if (!missingExecutable(error)) throw error;
    }
  }

  throw new Error("RCON client is unavailable for this server");
}

export function isServerStartingError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("container not found")
    || message.includes("container not running")
    || message.includes("no running pod found")
    || message.includes("server may be starting up")
    || message.includes("server is starting up");
}

export async function runServerCommand(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
  command: string,
  timeoutMs = 15000,
) {
  const deployment = await getServerDeployment(clients.appsApi, name);
  const gameType = getDeploymentGameType(deployment).toLowerCase();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_RETRY_DELAY_MS));
        continue;
      }
      throw new Error("No running pod found — server may be starting up");
    }

    const containerName = getPrimaryContainerName(pod, name);
    try {
      const result = await runRconCommand(clients.kc, pod.metadata.name, containerName, command, timeoutMs);
      return { ...result, gameType, pod, method: "rcon" as const };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if ((message.includes("container not found") || message.includes("container not running")) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Server is starting up, please try again in a moment");
}

export async function getNodeIp(coreApi: k8s.CoreV1Api, pod: k8s.V1Pod | null | undefined) {
  let nodeIp: string | null = process.env.GAME_HUB_EXTERNAL_HOSTNAME ?? null;
  if (nodeIp) return nodeIp;

  try {
    const nodeName = pod?.spec?.nodeName;
    if (nodeName) {
      const node = await coreApi.readNode({ name: nodeName });
      nodeIp = node.status?.addresses?.find((entry) => entry.type === "InternalIP")?.address ?? null;
    }
    if (!nodeIp) {
      const nodes = await coreApi.listNode();
      const ready = nodes.items.find((node) => node.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"));
      nodeIp = ready?.status?.addresses?.find((entry) => entry.type === "InternalIP")?.address ?? null;
    }
  } catch {
    return null;
  }

  return nodeIp;
}

export async function checkPortReachable(host: string | null, port: number | null, timeoutMs = 2000): Promise<boolean> {
  if (!host || !port) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function gracefulStopServer(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
  stopCommand: string | null | undefined,
  _timeoutMs = 30_000, // kept for API compat
) {
  // Scale to 0 first — this prevents the deployment from restarting the pod
  // after the game process exits. Without this the pod would just restart.
  await clients.appsApi.patchNamespacedDeployment({
    name,
    namespace: GAME_HUB_NS,
    body: { spec: { replicas: 0 }, metadata: { annotations: { "infraweaver.io/last-stopped": new Date().toISOString() } } },
    force: true,
    fieldManager: "infraweaver",
  });

  const pod = await getServerPod(clients.coreApi, name, true);
  const containerName = getPrimaryContainerName(pod, name);
  let stopCommandSent = false;

  // Send the egg's stop command via RCON so the game can save state cleanly
  // before the pod is terminated. execShell would run it as a shell command
  // (wrong); runRconCommand uses rcon-cli, the same path as the console tab.
  if (pod?.metadata?.name && stopCommand?.trim()) {
    try {
      await runRconCommand(clients.kc, pod.metadata.name, containerName, stopCommand.trim(), 8_000);
      stopCommandSent = true;
    } catch {
      // RCON not available for this game type or server not ready — OK, the
      // pod will be terminated via SIGTERM once replicas:0 is reconciled.
      stopCommandSent = false;
    }
  }

  // Brief grace window: let the game process exit on its own after the stop
  // command. If it exits quickly, the pod is already gone when k8s reconciles.
  // Total wait: up to 12s (6 × 2s polls) — well inside any proxy timeout.
  let exitedGracefully = false;
  if (stopCommandSent) {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const current = await getServerPod(clients.coreApi, name, true).catch(() => null);
      if (!current?.metadata?.name) {
        exitedGracefully = true;
        break;
      }
    }
  }

  return { stopCommandSent, exitedGracefully };
}

function parseJsonValue<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function readServerAudit(coreApi: k8s.CoreV1Api, name: string) {
  try {
    const configMap = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-audit`, namespace: GAME_HUB_NS });
    return parseJsonValue<ServerAuditEntry[]>(configMap.data?.[AUDIT_CONFIG_MAP_KEY], []);
  } catch {
    return [];
  }
}

export async function appendServerAudit(coreApi: k8s.CoreV1Api, name: string, entry: ServerAuditEntry) {
  const existing = await readServerAudit(coreApi, name);
  const body: k8s.V1ConfigMap = {
    metadata: {
      name: `gameserver-${name}-audit`,
      namespace: GAME_HUB_NS,
      labels: {
        app: name,
        "infraweaver/game": "true",
        "infraweaver/type": "audit-log",
      },
    },
    data: {
      [AUDIT_CONFIG_MAP_KEY]: JSON.stringify([...existing, entry].slice(-100), null, 2),
    },
  };

  try {
    await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-audit`, namespace: GAME_HUB_NS });
    await coreApi.replaceNamespacedConfigMap({ name: `gameserver-${name}-audit`, namespace: GAME_HUB_NS, body });
  } catch {
    await coreApi.createNamespacedConfigMap({ namespace: GAME_HUB_NS, body });
  }
}

export function createServerToken(label: string): ServerTokenRecord {
  const token = randomBytes(32).toString("hex");
  return {
    id: randomUUID(),
    label,
    token,
    prefix: `${token.slice(0, 8)}…${token.slice(-4)}`,
    createdAt: new Date().toISOString(),
  };
}

export async function readServerTokens(coreApi: k8s.CoreV1Api, name: string) {
  try {
    const secret = await coreApi.readNamespacedSecret({ name: `gameserver-${name}-tokens`, namespace: GAME_HUB_NS });
    const raw = secret.data?.[TOKENS_SECRET_KEY];
    if (!raw) return [] as ServerTokenRecord[];
    return parseJsonValue<ServerTokenRecord[]>(Buffer.from(raw, "base64").toString("utf8"), []);
  } catch {
    return [] as ServerTokenRecord[];
  }
}

export async function writeServerTokens(coreApi: k8s.CoreV1Api, name: string, tokens: ServerTokenRecord[]) {
  const body: k8s.V1Secret = {
    metadata: {
      name: `gameserver-${name}-tokens`,
      namespace: GAME_HUB_NS,
      labels: {
        app: name,
        "infraweaver/game": "true",
        "infraweaver/type": "api-token",
      },
    },
    type: "Opaque",
    data: {
      [TOKENS_SECRET_KEY]: Buffer.from(JSON.stringify(tokens, null, 2), "utf8").toString("base64"),
    },
  };

  try {
    await coreApi.readNamespacedSecret({ name: `gameserver-${name}-tokens`, namespace: GAME_HUB_NS });
    await coreApi.replaceNamespacedSecret({ name: `gameserver-${name}-tokens`, namespace: GAME_HUB_NS, body });
  } catch {
    await coreApi.createNamespacedSecret({ namespace: GAME_HUB_NS, body });
  }
}

export async function validateServerToken(coreApi: k8s.CoreV1Api, name: string, token: string) {
  const tokens = await readServerTokens(coreApi, name);
  return tokens.find((entry) => entry.token === token) ?? null;
}

export async function readSavedCommands(coreApi: k8s.CoreV1Api, name: string): Promise<SavedCommand[]> {
  try {
    const configMap = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NS });
    const raw = configMap.data?.[SAVED_COMMANDS_KEY];
    if (!raw) return [];
    return JSON.parse(raw) as SavedCommand[];
  } catch {
    return [];
  }
}

export async function writeSavedCommands(coreApi: k8s.CoreV1Api, name: string, commands: SavedCommand[]) {
  const payload = JSON.stringify(commands, null, 2);
  try {
    await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NS });
    await coreApi.patchNamespacedConfigMap({
      name: `gameserver-${name}-egg`,
      namespace: GAME_HUB_NS,
      body: { data: { [SAVED_COMMANDS_KEY]: payload } },
      fieldManager: "infraweaver",
      force: true,
    });
  } catch {
    await coreApi.createNamespacedConfigMap({
      namespace: GAME_HUB_NS,
      body: {
        metadata: {
          name: `gameserver-${name}-egg`,
          namespace: GAME_HUB_NS,
          labels: { app: name, "infraweaver/game": "true", "infraweaver/type": "game-egg" },
        },
        data: { [SAVED_COMMANDS_KEY]: payload },
      },
    });
  }
}

export function parsePlayerHistory(raw: string | undefined | null) {
  return parseJsonValue<PlayerHistoryPoint[]>(raw, [])
    .filter((entry) => Number.isFinite(entry.t) && Number.isFinite(entry.n))
    .map((entry) => ({ t: Number(entry.t), n: Number(entry.n) }));
}

export function trimPlayerHistory(history: PlayerHistoryPoint[], maxEntries = 48) {
  return history.slice(-maxEntries);
}

export function parseDiscordWebhookConfig(raw: string | undefined | null): DiscordWebhookConfig | null {
  const parsed = parseJsonValue<Partial<DiscordWebhookConfig> | null>(raw, null);
  if (!parsed?.url) return null;
  return {
    url: parsed.url,
    events: Array.isArray(parsed.events) ? parsed.events.filter((event): event is string => typeof event === "string") : [],
  };
}

export async function sendDiscordWebhook(config: DiscordWebhookConfig | null, event: string, content: string) {
  if (!config?.url) return;
  if (config.events.length > 0 && !config.events.includes(event)) return;
  const url = await parseSafeExternalUrl(config.url);
  if (!url) return;
  await requestSafeExternalUrl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
    maxResponseBytes: 64_000,
    timeoutMs: 8_000,
  }).catch(() => undefined);
}

const SCHEDULE_DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const SCHEDULE_DAY_TO_CRON: Record<(typeof SCHEDULE_DAY_ORDER)[number], string> = {
  sun: "0",
  mon: "1",
  tue: "2",
  wed: "3",
  thu: "4",
  fri: "5",
  sat: "6",
};

export function parsePowerSchedule(input: unknown): PowerSchedule | null {
  let value = input;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PowerSchedule>;
  const time = typeof candidate.time === "string" ? candidate.time.trim() : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;

  const days = Array.isArray(candidate.days)
    ? Array.from(new Set(candidate.days
      .map((day) => (typeof day === "string" ? day.trim().toLowerCase().slice(0, 3) : ""))
      .filter((day): day is (typeof SCHEDULE_DAY_ORDER)[number] => SCHEDULE_DAY_ORDER.includes(day as (typeof SCHEDULE_DAY_ORDER)[number]))))
    : [];
  const normalizedDays = days.length ? [...days].sort((a, b) => SCHEDULE_DAY_ORDER.indexOf(a) - SCHEDULE_DAY_ORDER.indexOf(b)) : [...SCHEDULE_DAY_ORDER];
  const timezone = typeof candidate.timezone === "string" && candidate.timezone.trim()
    ? candidate.timezone.trim()
    : "UTC";

  return { time, days: normalizedDays, timezone };
}

export function buildPowerScheduleCron(schedule: PowerSchedule) {
  const [hours, minutes] = schedule.time.split(":").map((entry) => Number.parseInt(entry, 10));
  const days = (schedule.days.length ? schedule.days : [...SCHEDULE_DAY_ORDER])
    .map((day) => SCHEDULE_DAY_TO_CRON[day as (typeof SCHEDULE_DAY_ORDER)[number]])
    .join(",");
  return `${minutes} ${hours} * * ${days}`;
}

export async function createCronJob(batchApi: k8s.BatchV1Api, name: string, schedule: string, command: string, labels: Record<string, string> = {}, timeZone?: string | null) {
  const body: k8s.V1CronJob = {
    apiVersion: "batch/v1",
    kind: "CronJob",
    metadata: {
      name,
      namespace: GAME_HUB_NS,
      labels,
    },
    spec: {
      schedule,
      ...(timeZone ? { timeZone } : {}),
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        spec: {
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [{
                name: "runner",
                image: "bitnami/kubectl:latest",
                command: ["/bin/sh", "-c", command],
              }],
            },
          },
        },
      },
    },
  };

  try {
    await batchApi.readNamespacedCronJob({ name, namespace: GAME_HUB_NS });
    await batchApi.replaceNamespacedCronJob({ name, namespace: GAME_HUB_NS, body });
  } catch {
    await batchApi.createNamespacedCronJob({ namespace: GAME_HUB_NS, body });
  }
}

export const upsertCronJob = createCronJob;

export async function deleteCronJob(batchApi: k8s.BatchV1Api, name: string) {
  await batchApi.deleteNamespacedCronJob({ name, namespace: GAME_HUB_NS }).catch(() => undefined);
}

export function parseCpuQuantity(value: string | null | undefined) {
  if (!value) return 0;
  const trimmed = value.trim();
  if (trimmed.endsWith("n")) return Number.parseFloat(trimmed.slice(0, -1)) / 1_000_000_000;
  if (trimmed.endsWith("u")) return Number.parseFloat(trimmed.slice(0, -1)) / 1_000_000;
  if (trimmed.endsWith("m")) return Number.parseFloat(trimmed.slice(0, -1)) / 1000;
  return Number.parseFloat(trimmed);
}

export function parseMemoryBytes(value: string | null | undefined) {
  if (!value) return 0;
  const trimmed = value.trim();
  const match = trimmed.match(/^([0-9.]+)\s*([KMGTE]i|[kMGTPE])?$/);
  if (!match) return Number.parseFloat(trimmed) || 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = match[2] ?? "";
  const multipliers: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    k: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
    P: 1000 ** 5,
    E: 1000 ** 6,
  };
  return amount * (multipliers[unit] ?? 1);
}
