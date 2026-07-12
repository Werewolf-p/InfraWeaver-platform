import * as k8s from "@kubernetes/client-node";
import { createConfiguration, ServerConfiguration, type RequestContext, type ResponseContext } from "@kubernetes/client-node";
import { randomBytes, randomUUID } from "crypto";
import net from "net";
import { Writable } from "stream";
import type { Session } from "next-auth";
import { getEggForGameType, type GameEgg, type SavedCommand } from "./game-eggs";
import { GAME_HUB_NAMESPACE, parseEggConfig } from "./game-hub";
import { auditLog } from "@/lib/audit-log";
import { getEffectivePermissions, type Permission, type RoleAssignment } from "@/lib/rbac";
import { loadKubeConfig } from "@/lib/k8s";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";
import { isPodInstalling } from "@/lib/pod-install-state";
import { UserError } from "@/lib/utils";

// Re-exported so callers importing via the `@/lib/game-hub-server` shim keep working.
export { isPodInstalling };

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
  expiresAt?: string;
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
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error("No active cluster for game-hub");

  // The k8s client 1.x picks application/json-patch+json by default (first in
  // the list) for all PATCH calls.  We always send strategic-merge-patch objects,
  // so we add a pre-request middleware that overwrites the Content-Type header
  // before the HTTP request is actually dispatched.
  const mergePatchMiddleware = {
    pre: async (ctx: RequestContext): Promise<RequestContext> => {
      if (ctx.getHttpMethod() === "PATCH") {
        ctx.setHeaderParam("Content-Type", "application/strategic-merge-patch+json");
      }
      return ctx;
    },
    post: async (rsp: ResponseContext): Promise<ResponseContext> => rsp,
  };

  const cfg = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authMethods: { default: kc as any },
    promiseMiddleware: [mergePatchMiddleware],
  });

  return {
    kc,
    appsApi: new k8s.AppsV1Api(cfg),
    autoscalingApi: new k8s.AutoscalingV2Api(cfg),
    batchApi: new k8s.BatchV1Api(cfg),
    coreApi: new k8s.CoreV1Api(cfg),
    customObjectsApi: new k8s.CustomObjectsApi(cfg),
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

function kubernetesErrorText(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "";

  const statusText = typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? `HTTP ${String((error as { statusCode?: number }).statusCode)}`
    : "";
  const body = (error as { body?: { message?: unknown; reason?: unknown; code?: unknown } }).body;
  const bodyText = [body?.message, body?.reason, body?.code]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ");

  return `${statusText} ${bodyText}`.trim();
}

export function getKubernetesErrorStatus(error: unknown) {
  if (typeof error !== "object" || error === null) return null;

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === "number") return statusCode;

  const bodyCode = (error as { body?: { code?: unknown } }).body?.code;
  if (typeof bodyCode === "number") return bodyCode;

  return null;
}

export function isKubernetesNotFoundError(error: unknown) {
  return getKubernetesErrorStatus(error) === 404 || /404|not\s*found/i.test(kubernetesErrorText(error));
}

export type ServerPowerStatus = "maintenance" | "running" | "stopping" | "stopped";

/**
 * Power-state portion of a game server's status, derived purely from the
 * deployment's desired (spec) and observed (status) replica counts.
 *
 * "stopping" covers the graceful-shutdown window after a Stop: the desired
 * count is 0 (so the in-game stop command has been sent and the workload
 * scaled down) but pods are still terminating (status.replicas > 0). It is
 * fully cluster-derived — there is no user-settable flag — and settles to
 * "stopped" once the last pod exits.
 *
 * Returns null while the deployment wants pods but none are ready yet, so
 * callers can layer their own transitional states (starting/installing/
 * crash-loop) on top.
 */
export function derivePowerStatus(opts: {
  maintenanceMode: boolean;
  specReplicas: number | null | undefined;
  statusReplicas: number;
  readyReplicas: number;
}): ServerPowerStatus | null {
  if (opts.maintenanceMode) return "maintenance";
  if ((opts.specReplicas ?? 0) === 0) {
    return opts.statusReplicas > 0 ? "stopping" : "stopped";
  }
  if (opts.readyReplicas > 0) return "running";
  return null;
}

export async function getServerDeployment(appsApi: k8s.AppsV1Api, name: string) {
  return appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
}

export async function getServerStatefulSet(appsApi: k8s.AppsV1Api, name: string) {
  return appsApi.readNamespacedStatefulSet({ name, namespace: GAME_HUB_NS });
}

export async function scaleServerWorkload(appsApi: k8s.AppsV1Api, name: string, replicas: number) {
  const nextReplicas = Math.max(0, replicas);

  // Use read+replace (PUT) instead of PATCH to avoid content-type negotiation issues.
  // The k8s client v1.x picks application/json-patch+json for PATCH calls, which Kubernetes
  // rejects with 422 "force: Forbidden: may not be specified for non-apply patch" when
  // fieldManager is included. PUT (replaceNamespacedDeploymentScale) avoids this entirely.
  try {
    const scale = await appsApi.readNamespacedDeploymentScale({ name, namespace: GAME_HUB_NS });
    await appsApi.replaceNamespacedDeploymentScale({
      name,
      namespace: GAME_HUB_NS,
      body: {
        ...scale,
        spec: { ...(scale.spec ?? {}), replicas: nextReplicas },
      },
    });
    return { kind: "deployment" as const, replicas: nextReplicas };
  } catch (deploymentError) {
    try {
      const scale = await appsApi.readNamespacedStatefulSetScale({ name, namespace: GAME_HUB_NS });
      await appsApi.replaceNamespacedStatefulSetScale({
        name,
        namespace: GAME_HUB_NS,
        body: {
          ...scale,
          spec: { ...(scale.spec ?? {}), replicas: nextReplicas },
        },
      });
      return { kind: "statefulset" as const, replicas: nextReplicas };
    } catch {
      throw deploymentError;
    }
  }
}

export async function getServerPod(coreApi: k8s.CoreV1Api, name: string, runningOnly = false) {
  const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
  // Exclude pods being terminated — their phase stays "Running" during graceful shutdown
  const active = pods.items.filter((pod) => !pod.metadata?.deletionTimestamp);
  if (runningOnly) {
    const fullyRunning = active.find((pod) => {
      if (pod.status?.phase !== "Running") return false;
      const containerStatuses = pod.status?.containerStatuses ?? [];
      if (containerStatuses.length === 0) return false;
      return containerStatuses.every((cs) => cs.state?.running != null);
    });
    return fullyRunning ?? null;
  }
  return active.find((pod) => pod.status?.phase === "Running") ?? active[0] ?? null;
}

export function getPrimaryContainerName(pod: k8s.V1Pod | null | undefined, fallback: string) {
  return pod?.spec?.containers?.[0]?.name ?? fallback;
}

const STDIN_ONLY_GAMES = new Set(["terraria"]);
const SRCDS_GAMES = new Set(["cs2", "csgo", "tf2"]);

// Games whose server process has NO console/command interpreter. stdin is still
// delivered successfully to the process, but the game silently ignores it (no
// RCON, no in-game command parser). Used to give the operator a clear message
// instead of letting them believe the command did something.
const NO_STDIN_INTERPRETER_GAMES = new Set(["valheim"]);

/**
 * Friendly message shown in the console when a command is delivered via stdin to
 * a game that has no command interpreter (e.g. vanilla Valheim). The stdin write
 * succeeds but the game does nothing with it.
 */
export function noInterpreterConsoleNote(gameType: string) {
  const label = gameType || "this game";
  return `Note: ${label} has no built-in console or RCON command interpreter. Your input was delivered to the server process via stdin, but the game ignores it — nothing will happen. Use in-game admin tools, config files, or a community RCON mod to manage this server.`;
}

// Env var name patterns for auto-detection across ANY game engine/egg
const RCON_PASS_RE = /(?:^|_)RCON_?(?:PASS(?:WORD)?|PW)$|^SRCDS_RCONPW$/i;
const RCON_PORT_RE = /(?:^|_)RCON_?PORT$|^SRCDS_PORT$/i;
const RCON_ENABLE_RE = /^ENABLE_?RCON$|^RCON_?ENABLED$/i;

export interface RconCommandCandidate {
  method: "mcrcon" | "rcon";
  commands: string[][];
}

function getEggEnvValue(egg: GameEgg | null | undefined, name: string) {
  return egg?.environment.find((entry) => entry.name === name)?.defaultValue?.trim() ?? "";
}

/** Extract all env vars from a live deployment as a flat map (runtime values). */
export function getDeploymentEnvMap(deployment: k8s.V1Deployment | null | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const container of deployment?.spec?.template?.spec?.containers ?? []) {
    for (const env of container.env ?? []) {
      if (env.name && env.value != null) map[env.name] = env.value;
    }
  }
  return map;
}

function isMinecraftGame(gameType: string) {
  return gameType.includes("minecraft");
}

function isSrcdsGame(gameType: string) {
  return SRCDS_GAMES.has(gameType);
}

function expandBinaryCandidates(binary: string, args: string[]) {
  return [
    [`/usr/local/bin/${binary}`, ...args],
    [`/usr/bin/${binary}`, ...args],
    [binary, ...args],
  ];
}

/**
 * Universal RCON auto-detection: scans the live deployment env for any
 * RCON-pattern variables (password + port). Works for unknown/new game eggs
 * without any per-game configuration.
 */
function autoDetectRconFromEnv(env: Record<string, string>, command: string): RconCommandCandidate[] {
  const passKey = Object.keys(env).find((k) => RCON_PASS_RE.test(k));
  const portKey = Object.keys(env).find((k) => RCON_PORT_RE.test(k));
  const password = passKey ? env[passKey] : "";
  const port = portKey ? env[portKey] : "";
  if (!password || !port) return [];

  // If there's an explicit enable flag, respect it
  const enableKey = Object.keys(env).find((k) => RCON_ENABLE_RE.test(k));
  if (enableKey) {
    const v = env[enableKey].toLowerCase();
    if (v !== "true" && v !== "1" && v !== "yes") return [];
  }

  return [{ method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) }];
}

/**
 * Build RCON command candidates for a game server.
 * Runtime env (from the actual deployment) takes priority over egg defaults so
 * auto-generated passwords are always used. Falls back to universal pattern
 * detection for any game not explicitly handled.
 */
export function getGameRconArgs(
  gameType: string,
  egg: GameEgg | null | undefined,
  runtimeEnv: Record<string, string>,
  command: string,
): RconCommandCandidate[] {
  // Runtime value first, then egg default value
  const env = (name: string) => runtimeEnv[name]?.trim() || getEggEnvValue(egg, name);

  if (isMinecraftGame(gameType)) {
    const password = env("RCON_PASSWORD");
    const port = env("RCON_PORT") || "25575";
    if (!password) return autoDetectRconFromEnv(runtimeEnv, command);
    return [
      { method: "mcrcon", commands: expandBinaryCandidates("mcrcon", ["-H", "localhost", "-P", port, "-p", password, command]) },
      { method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) },
    ];
  }

  if (gameType === "valheim") {
    const password = env("SERVER_RCON_PASSWORD") || env("RCON_PASSWORD");
    const port = env("SERVER_RCON_PORT") || env("RCON_PORT") || "2458";
    if (!password) return autoDetectRconFromEnv(runtimeEnv, command);
    return [{ method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) }];
  }

  if (gameType === "rust") {
    const password = env("RCON_PASSWORD");
    const port = env("RCON_PORT") || "28016";
    if (!password) return autoDetectRconFromEnv(runtimeEnv, command);
    return [{ method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) }];
  }

  if (isSrcdsGame(gameType)) {
    const password = env("SRCDS_RCONPW");
    const port = env("SRCDS_PORT") || "27015";
    if (!password) return autoDetectRconFromEnv(runtimeEnv, command);
    return [{ method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) }];
  }

  // ARK: Survival Evolved / Ascended
  if (gameType.includes("ark")) {
    const password = env("ARK_RCON_PASSWORD") || env("RCON_PASSWORD");
    const port = env("ARK_RCON_PORT") || env("RCON_PORT") || "32330";
    if (!password) return autoDetectRconFromEnv(runtimeEnv, command);
    return [{ method: "rcon", commands: expandBinaryCandidates("rcon-cli", ["--host", "localhost", "--port", port, "--password", password, command]) }];
  }

  // Any other game: try universal env-pattern detection
  return autoDetectRconFromEnv(runtimeEnv, command);
}

export interface RconConnection {
  port: number;
  password: string;
  /** Wire protocol: "source" = Valve Source RCON (Minecraft/Valheim-RCON/ARK/Source). */
  protocol: "source";
}

/**
 * Resolve a native (binary-free) Source RCON connection for a game server.
 * Returns the RCON port + password to dial directly over TCP from the console,
 * so we never depend on an rcon client binary being present inside the game
 * container. Works for any game/egg that exposes Source-protocol RCON, including
 * unknown eggs via universal env-pattern detection. Returns null when the game
 * has no Source RCON (e.g. Rust uses WebSocket RCON, vanilla Valheim has none).
 */
export function getRconConnection(
  gameType: string,
  egg: GameEgg | null | undefined,
  runtimeEnv: Record<string, string>,
): RconConnection | null {
  const env = (name: string) => runtimeEnv[name]?.trim() || getEggEnvValue(egg, name);
  const num = (v: string, fallback: number) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  // Rust uses a WebSocket-based RCON, not Source — leave to CLI/autodetect path.
  if (gameType === "rust") return null;

  if (isMinecraftGame(gameType)) {
    const password = env("RCON_PASSWORD");
    if (password) return { port: num(env("RCON_PORT"), 25575), password, protocol: "source" };
  } else if (isSrcdsGame(gameType)) {
    const password = env("SRCDS_RCONPW");
    if (password) return { port: num(env("SRCDS_PORT"), 27015), password, protocol: "source" };
  } else if (gameType.includes("ark")) {
    const password = env("ARK_RCON_PASSWORD") || env("RCON_PASSWORD");
    if (password) return { port: num(env("ARK_RCON_PORT") || env("RCON_PORT"), 32330), password, protocol: "source" };
  } else if (gameType === "valheim") {
    const password = env("SERVER_RCON_PASSWORD") || env("RCON_PASSWORD");
    if (password) return { port: num(env("SERVER_RCON_PORT") || env("RCON_PORT"), 2458), password, protocol: "source" };
  }

  // Universal fallback: any egg that declares an RCON password + port via env.
  const passKey = Object.keys(runtimeEnv).find((k) => RCON_PASS_RE.test(k));
  const portKey = Object.keys(runtimeEnv).find((k) => RCON_PORT_RE.test(k));
  if (passKey && portKey) {
    const enableKey = Object.keys(runtimeEnv).find((k) => RCON_ENABLE_RE.test(k));
    const enabled = !enableKey || ["true", "1", "yes"].includes(runtimeEnv[enableKey].toLowerCase());
    const password = runtimeEnv[passKey];
    const port = num(runtimeEnv[portKey], 0);
    if (enabled && password && port) return { port, password, protocol: "source" };
  }

  return null;
}

const SOURCE_RCON_AUTH = 3;
const SOURCE_RCON_EXEC = 2;

function encodeSourceRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  let off = 0;
  buf.writeInt32LE(size, off); off += 4;
  buf.writeInt32LE(id, off); off += 4;
  buf.writeInt32LE(type, off); off += 4;
  bodyBuf.copy(buf, off); off += bodyBuf.length;
  buf.writeInt16LE(0, off);
  return buf;
}

/**
 * Native Source RCON over TCP. No in-container binary required — the console
 * dials the game pod directly. Authenticates, sends one command, and collects
 * the response. Universal across all Source-protocol games.
 */
export function sourceRconCommand(
  host: string,
  port: number,
  password: string,
  command: string,
  timeoutMs = 8000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let output = "";
    let settled = false;
    const AUTH_ID = 1;
    const EXEC_ID = 2;
    const END_ID = 3; // sentinel empty command to detect end of multi-packet reply

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve({ stdout: output, stderr: "" });
    };

    const timer = setTimeout(() => {
      // If authenticated, return whatever we collected rather than failing.
      if (authed) finish(null);
      else finish(new Error(`RCON timeout connecting to ${host}:${port}`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(encodeSourceRconPacket(AUTH_ID, SOURCE_RCON_AUTH, password));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (buffer.length < 4 + size) break;
        const id = buffer.readInt32LE(4);
        const body = buffer.slice(12, 4 + size - 2).toString("utf8");
        buffer = buffer.slice(4 + size);

        if (!authed) {
          if (id === -1) { finish(new Error("RCON authentication failed (wrong password)")); return; }
          authed = true;
          socket.write(encodeSourceRconPacket(EXEC_ID, SOURCE_RCON_EXEC, command));
          // Empty sentinel: its echoed response marks the end of the real reply.
          socket.write(encodeSourceRconPacket(END_ID, SOURCE_RCON_EXEC, ""));
          continue;
        }
        if (id === END_ID) { finish(null); return; }
        if (id === EXEC_ID) output += body;
      }
    });

    socket.on("error", (err) => finish(err));
    socket.on("close", () => { if (authed) finish(null); else finish(new Error("RCON connection closed before auth")); });
  });
}

function buildCommandExecutionError(gameType: string, transportError: unknown, stdinError?: unknown) {
  const detail = [transportError, stdinError]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (value instanceof Error ? value.message : String(value)).trim())
    .find(Boolean);
  const suffix = detail ? ` (${detail})` : "";
  const label = gameType || "server";
  return new UserError(
    `This game server does not support remote console commands. Some servers (like vanilla Valheim) have no built-in command interface — try connecting to the game directly to manage it. [${label}]${suffix}`.trim(),
  );
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
  // Captured so we can close the underlying WebSocket on timeout — otherwise the
  // socket (and its pod exec stream) leaks whenever the command outlives timeoutMs.
  let socket: { close: () => void } | null = null;

  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      if (settled) return; // guard against double-settle (timeout + close/error race)
      settled = true;
      clearTimeout(timeout);
      try {
        socket?.close();
      } catch {
        // best-effort: socket may already be closing
      }
      if (error) reject(error);
      else resolve();
    };

    // Timeout must REJECT, not resolve: a command that outlives its budget
    // (e.g. a large `tar` backup or restore extraction) would otherwise return
    // partial stdout as "success" — storing a truncated archive as a good backup,
    // or reporting a half-finished restore as complete. Callers that are
    // best-effort (console/stdin writes) already wrap this in try/catch.
    const timeout = setTimeout(
      () => done(new Error(`exec timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const stdoutStream = new Writable({ write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); } });
    const stderrStream = new Writable({ write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); } });

    exec.exec(GAME_HUB_NS, podName, containerName, command, stdoutStream, stderrStream, null, false, (status) => {
      if (status?.status === "Failure") done(new Error(status.message ?? "Exec failed"));
      else done();
    }).then((ws) => {
      socket = ws;
      // If we already timed out before the socket resolved, close it immediately.
      if (settled) {
        try { ws.close(); } catch { /* already closing */ }
        return;
      }
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

export function buildConsoleInputScript(command: string) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("command is required");
  if (trimmed === "^C") return "kill -INT 1";
  const quoted = shellQuote(trimmed);
  // Processes that are never the game server — skip their stdins
  const skipComms = "pause|sh|bash|dash|ash|sleep|init|tini|runit|s6|python3|python|supervisord|supervisor|crond|cron|syslogd|logfilter|updater|busybox|grep|cat|ls";
  return [
    // Method 1: Minecraft named-pipe helper (Minecraft-specific)
    "if command -v mc-send-to-console >/dev/null 2>&1 && [ -p /tmp/minecraft-console-in ]; then",
    `  mc-send-to-console ${quoted}`,
    "else",
    // Method 2: scan all process stdins; find first non-/dev/null writable one
    // that belongs to the game binary (skip common system/infra processes)
    "  SENT=0",
    `  for _P in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$' | sort -rn); do`,
    "    [ \"$_P\" = \"1\" ] && continue",
    "    _FD=\"/proc/$_P/fd/0\"",
    "    _TGT=$(readlink \"$_FD\" 2>/dev/null) || continue",
    "    [ \"$_TGT\" = \"/dev/null\" ] && continue",
    "    _COM=$(cat \"/proc/$_P/comm\" 2>/dev/null)",
    `    case \"$_COM\" in ${skipComms}) continue ;; esac`,
    "    [ -w \"$_FD\" ] || continue",
    "    printf '%s\\n' " + quoted + " > \"$_FD\" 2>/dev/null && SENT=1 && break",
    "  done",
    // Method 3: PID 1 fallback (works when tini/init has a real stdin)
    "  if [ \"$SENT\" = \"0\" ]; then",
    "    if [ -w /proc/1/fd/0 ] && [ \"$(readlink /proc/1/fd/0 2>/dev/null || true)\" != \"/dev/null\" ]; then",
    `      printf '%s\\n' ${quoted} > /proc/1/fd/0`,
    "    else",
    "      echo \"No supported stdin console input method found\" >&2",
    "      exit 1",
    "    fi",
    "  fi",
    "fi",
  ].join("\n");
}

export async function sendConsoleInputViaExec(
  kc: k8s.KubeConfig,
  podName: string,
  containerName: string,
  command: string,
  timeoutMs = 8000,
) {
  return execShell(kc, podName, containerName, buildConsoleInputScript(command), timeoutMs);
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
  candidates: RconCommandCandidate[],
  timeoutMs = 15000,
) {
  let lastError: unknown = null;

  for (const candidate of candidates) {
    for (const command of candidate.commands) {
      try {
        const result = await execInPod(kc, podName, containerName, command, timeoutMs);
        return { ...result, method: candidate.method };
      } catch (error) {
        if (missingExecutable(error)) continue;
        lastError = error;
        break;
      }
    }
  }

  if (lastError) throw lastError;
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
  const egg = await readServerEgg(clients.coreApi, name, deployment);
  const gameType = (egg.id || getDeploymentGameType(deployment)).toLowerCase();
  const runtimeEnv = getDeploymentEnvMap(deployment);
  const isStdinOnly = STDIN_ONLY_GAMES.has(gameType);
  const rconConnection = isStdinOnly ? null : getRconConnection(gameType, egg, runtimeEnv);
  const rconCandidates = isStdinOnly ? [] : getGameRconArgs(gameType, egg, runtimeEnv, command);

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
    let transportError: unknown = null;

    // Tier 1: native Source RCON over TCP straight to the pod — no in-container
    // client binary needed. Universal across all Source-protocol games.
    const podIp = pod.status?.podIP;
    if (rconConnection && podIp) {
      try {
        const result = await sourceRconCommand(podIp, rconConnection.port, rconConnection.password, command, timeoutMs);
        return { ...result, gameType, pod, method: "rcon" as const };
      } catch (error) {
        transportError = error;
      }
    }

    // Tier 2: in-container rcon client binary (mcrcon/rcon-cli) if present.
    if (rconCandidates.length > 0) {
      try {
        const result = await runRconCommand(clients.kc, pod.metadata.name, containerName, rconCandidates, timeoutMs);
        return { ...result, gameType, pod };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        if ((message.includes("container not found") || message.includes("container not running")) && attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, COMMAND_RETRY_DELAY_MS));
          continue;
        }
        transportError = error;
      }
    }

    try {
      const result = await sendConsoleInputViaExec(clients.kc, pod.metadata.name, containerName, command, timeoutMs);
      const noInterpreter = NO_STDIN_INTERPRETER_GAMES.has(gameType);
      return {
        ...result,
        gameType,
        pod,
        method: (noInterpreter ? "stdin-noninteractive" : "stdin") as "stdin" | "stdin-noninteractive",
        ...(noInterpreter ? { note: noInterpreterConsoleNote(gameType) } : {}),
      };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if ((message.includes("container not found") || message.includes("container not running")) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, COMMAND_RETRY_DELAY_MS));
        continue;
      }
      throw buildCommandExecutionError(gameType, transportError ?? error, transportError ? error : undefined);
    }
  }

  throw new Error("Server is starting up, please try again in a moment");
}

// ── Centralized command authorization (blocklist + per-role ACL) ─────────────
// Applied identically by /command, /rcon, and /exec so every command-execution
// surface enforces the same policy (DRY). The two layers are:
//   1. Deployment-level blocklist annotation (game-hub/command-blocklist).
//   2. Per-role ACL from the egg (game-server-admin/operator/viewer).

function parseCommandBlocklist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function commandAclRoleKey(perms: Set<Permission>): string {
  if (perms.has("*") || perms.has("game-hub:admin")) return "game-server-admin";
  if (
    perms.has("game-hub:write")
    || perms.has("game-hub:console")
    || perms.has("game-hub:files")
    || perms.has("game-hub:start")
    || perms.has("game-hub:stop")
  ) {
    return "game-server-operator";
  }
  return "game-server-viewer";
}

export function isCommandAllowedByAcl(command: string, allowed: string[]): boolean {
  if (allowed.includes("*")) return true;
  return allowed.some((entry) => command === entry || command.startsWith(`${entry} `));
}

export interface CommandGuardContext {
  groups: string[];
  username: string;
  roleAssignments: RoleAssignment[];
}

export type CommandGuardResult =
  | { allowed: true }
  | { allowed: false; reason: "blocklist" | "acl"; message: string };

/**
 * Decide whether `command` may run against server `name` for the given caller.
 * Enforces the deployment blocklist first, then the egg's per-role ACL. Returns
 * a structured result so callers can map the denial reason to an audit tag.
 */
export async function assertCommandAllowed(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
  command: string,
  ctx: CommandGuardContext,
): Promise<CommandGuardResult> {
  const deployment = await getServerDeployment(clients.appsApi, name);
  const egg = await readServerEgg(clients.coreApi, name, deployment);

  const blocklist = parseCommandBlocklist(deployment.metadata?.annotations?.["game-hub/command-blocklist"]);
  const normalized = command.trim().toLowerCase();
  const blocked = blocklist.some((entry) => {
    const normalizedEntry = entry.trim().toLowerCase();
    return normalizedEntry.length > 0 && normalized.startsWith(normalizedEntry);
  });
  if (blocked) {
    return { allowed: false, reason: "blocklist", message: "Command blocked by server policy" };
  }

  const perms = getEffectivePermissions(ctx.groups, ctx.username, ctx.roleAssignments, `/game-hub/servers/${name}`);
  const allowed = egg.commandAcl?.[commandAclRoleKey(perms)] ?? [];
  if (!isCommandAllowedByAcl(command, allowed)) {
    return { allowed: false, reason: "acl", message: "Command not allowed for your role" };
  }

  return { allowed: true };
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
  _stopCommand: string | null | undefined,
  _timeoutMs = 30_000, // kept for API compat
) {
  void _timeoutMs;
  // The pod's preStop lifecycle hook performs the ACTUAL stop (Tier-1 RCON stop
  // → stdin → signal) when we scale to 0, so we no longer send the stop command
  // over the unreliable /proc stdin path here. Instead we flush the world to
  // disk over native RCON first, so no progress is lost even if the runtime's
  // own shutdown-save is slow or absent. Best-effort: a game without a save
  // command (or with RCON unavailable) simply skips this and relies on preStop.
  void _stopCommand;
  let savedGracefully = false;
  try {
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const saveCommand = egg.saveCommand?.trim();
    if (saveCommand) {
      await runServerCommand(clients, name, saveCommand);
      savedGracefully = true;
    }
  } catch {
    savedGracefully = false;
  }

  await scaleServerWorkload(clients.appsApi, name, 0);

  // NOTE: we intentionally do NOT block here waiting for the pod to terminate.
  // A synchronous poll loop made the stop request take ~20s, long enough for the
  // browser/proxy to abort it ("TypeError: Failed to fetch"). Scaling to 0 has
  // already issued the shutdown; the UI polls server status every 15s and will
  // reflect the stopped state on the next refresh.
  //
  // `exitedGracefully` now reflects whether we confirmed a world-save over RCON
  // before shutdown — not merely that an exec call didn't throw.
  return { savedGracefully, exitedGracefully: savedGracefully };
}

export async function forceStopServer(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
) {
  const pods = await clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
  await scaleServerWorkload(clients.appsApi, name, 0);
  await Promise.all((pods.items ?? []).map((pod) => {
    const podName = pod.metadata?.name;
    if (!podName) return Promise.resolve(undefined);
    return clients.coreApi.deleteNamespacedPod({
      name: podName,
      namespace: GAME_HUB_NS,
      gracePeriodSeconds: 0,
      body: { gracePeriodSeconds: 0 },
    }).catch(() => undefined);
  }));
  return { deletedPods: (pods.items ?? []).map((pod) => pod.metadata?.name).filter((podName): podName is string => Boolean(podName)) };
}

/**
 * Restart a server by deleting its pods so the (Recreate-strategy) Deployment
 * recreates them — but NEVER delete a pod that is still installing.
 *
 * Killing a mid-install pod throws away the in-progress install and the
 * replacement pod re-runs the whole thing from scratch. If a restart is issued
 * repeatedly while the install is running (e.g. the old console pod servicing a
 * reconcile/restart on every poll during a rolling update) the install can never
 * finish — the pod just churns for the install's whole duration. Installing pods
 * are skipped and returned so callers can surface why the restart was a no-op.
 */
export async function restartServerPods(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
): Promise<{ deleted: string[]; skippedInstalling: string[] }> {
  const pods = await clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
  const deleted: string[] = [];
  const skippedInstalling: string[] = [];
  await Promise.all((pods.items ?? []).map(async (pod) => {
    const podName = pod.metadata?.name;
    if (!podName) return;
    if (isPodInstalling(pod)) {
      skippedInstalling.push(podName);
      return;
    }
    await clients.coreApi.deleteNamespacedPod({ name: podName, namespace: GAME_HUB_NS }).catch(() => undefined);
    deleted.push(podName);
  }));
  return { deleted, skippedInstalling };
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
  const now = Date.now();
  return tokens.find((entry) => {
    if (entry.token !== token) return false;
    if (!entry.expiresAt) return true;
    return new Date(entry.expiresAt).getTime() >= now;
  }) ?? null;
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
    const existing = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NS });
    await coreApi.replaceNamespacedConfigMap({
      name: `gameserver-${name}-egg`,
      namespace: GAME_HUB_NS,
      body: { ...existing, data: { ...(existing.data ?? {}), [SAVED_COMMANDS_KEY]: payload } },
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

// Generic k8s quantity parsers live in core (@/lib/k8s-quantity). Re-exported
// here so existing addon importers keep working.
export { parseCpuQuantity, parseMemoryBytes } from "@/lib/k8s-quantity";

// ─────────────────────────────────────────────────────────────────────────────
// Route-handler helpers — consolidate the audit/error boilerplate repeated
// across app/api/game-hub/**/route.ts. These mirror the EXISTING handler
// behavior byte-for-byte (envelopes, ordering, status codes) so callers can
// adopt them without any semantic change. The next/server-coupled wrappers
// (withGameHubAuth, toApiErrorResponse) live in ./game-hub-route so this domain
// lib stays free of next/server; both are re-exported via the
// `@/lib/game-hub-server` shim.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Double-write an audit record the way mutating game-hub routes do today:
 * the global audit log (`game-hub:<action>`) AND the per-server audit
 * ConfigMap (same action/details, actor = session email or "unknown").
 */
export async function auditServerAction(
  coreApi: k8s.CoreV1Api,
  name: string,
  session: Session | null,
  action: string,
  details: string,
): Promise<void> {
  const user = session?.user?.email ?? "unknown";
  await auditLog(`game-hub:${action}`, user, `${name} — ${details}`);
  await appendServerAudit(coreApi, name, {
    timestamp: new Date().toISOString(),
    user,
    action,
    details,
  });
}

/**
 * Map an unknown (usually Kubernetes client) error to an HTTP status:
 * the error's own statusCode/body.code when present, else 404 for
 * not-found-shaped errors, else 500.
 */
export function k8sErrorStatus(error: unknown): number {
  const status = getKubernetesErrorStatus(error);
  if (status !== null) return status;
  return isKubernetesNotFoundError(error) ? 404 : 500;
}

// ── Deployment annotation readers (dual `infraweaver.io/` + `infraweaver/`) ──

export type AnnotatedResource = { metadata?: { annotations?: Record<string, string> } } | null | undefined;

/**
 * Read an annotation off a resource. Bare keys (no "/") are tried under the
 * `infraweaver.io/` prefix first, then legacy `infraweaver/` — the exact
 * fallback order the routes use inline. Fully-qualified keys (containing "/",
 * e.g. "game-hub/announcements") are read as-is.
 */
export function annotation(resource: AnnotatedResource, key: string, fallback = ""): string {
  const annotations = resource?.metadata?.annotations ?? {};
  if (key.includes("/")) return annotations[key] ?? fallback;
  return annotations[`infraweaver.io/${key}`] ?? annotations[`infraweaver/${key}`] ?? fallback;
}

/**
 * Integer annotation with fallback. Mirrors the routes' inline
 * `parseInt(raw ?? "N", 10) || N`: NaN AND 0 both yield the fallback.
 */
export function intAnnotation(resource: AnnotatedResource, key: string, fallback: number): number {
  return Number.parseInt(annotation(resource, key, ""), 10) || fallback;
}

/** Comma-separated annotation → trimmed, non-empty entries (e.g. tags). */
export function csvAnnotation(resource: AnnotatedResource, key: string): string[] {
  const raw = annotation(resource, key, "");
  return raw ? raw.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

// ── Misc route helpers ───────────────────────────────────────────────────────

/**
 * Live TCP dial with latency measurement (the connectivity route's inline
 * checkTcpConnect). Unlike {@link checkPortReachable} it reports how long the
 * connect took; a null/missing host or port resolves closed immediately.
 */
export async function tcpProbe(
  host: string | null,
  port: number | null,
  timeoutMs = 3000,
): Promise<{ open: boolean; latencyMs: number | null }> {
  if (!host || !port) {
    return { open: false, latencyMs: null };
  }

  return new Promise<{ open: boolean; latencyMs: number | null }>((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ open, latencyMs: open ? Date.now() - startedAt : null });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Create-or-replace a ConfigMap (the read → replace, create-on-miss pattern
 * used by appendServerAudit / writeSavedCommands / the egg route).
 * `body.metadata.name` is required.
 */
export async function upsertConfigMap(
  coreApi: k8s.CoreV1Api,
  body: k8s.V1ConfigMap,
  namespace: string = GAME_HUB_NS,
): Promise<void> {
  const name = body.metadata?.name;
  if (!name) throw new Error("upsertConfigMap requires body.metadata.name");
  try {
    await coreApi.readNamespacedConfigMap({ name, namespace });
    await coreApi.replaceNamespacedConfigMap({ name, namespace, body });
  } catch {
    await coreApi.createNamespacedConfigMap({ namespace, body });
  }
}

/** Normalize a resource quantity: numbers → string, blank/nullish → undefined. */
export function quantityToString(value: string | number | null | undefined): string | undefined {
  if (typeof value === "number") return String(value);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Canonical label set stamped on game-server workloads/PVCs/services
 * (dual `infraweaver/` + `infraweaver.io/` prefixes, matching create/clone).
 * Pass `eggLabel` (already label-sanitized) to include game-type/egg labels.
 */
export function gameServerLabels(name: string, eggLabel?: string): Record<string, string> {
  return {
    app: name,
    "infraweaver/game": "true",
    "infraweaver.io/game": "true",
    ...(eggLabel
      ? {
          "infraweaver/game-type": eggLabel,
          "infraweaver.io/game-type": eggLabel,
          "infraweaver/egg": eggLabel,
          "infraweaver.io/egg": eggLabel,
        }
      : {}),
  };
}

/**
 * Label selector for game-hub list calls: all game servers when no name is
 * given (`infraweaver/game=true`), one server's resources otherwise (`app=<name>`).
 */
export function gameServerSelector(name?: string): string {
  return name ? `app=${name}` : "infraweaver/game=true";
}

export type GameServerListStatus = "maintenance" | "stopped" | "running" | "starting";

/**
 * Coarse list-view status derived from a deployment (the /search route's
 * inline serverStatus). Unlike {@link derivePowerStatus} it never returns
 * null — pods desired but not ready reads as "starting".
 */
export function serverStatus(deployment: {
  metadata?: { annotations?: Record<string, string> };
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; replicas?: number };
}): GameServerListStatus {
  if (deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true") return "maintenance";
  if ((deployment.spec?.replicas ?? 0) === 0) return "stopped";
  if ((deployment.status?.readyReplicas ?? 0) > 0) return "running";
  if ((deployment.status?.replicas ?? 0) > 0) return "starting";
  return "stopped";
}
