import * as k8s from "@kubernetes/client-node";
import { createConfiguration, ServerConfiguration, type RequestContext, type ResponseContext } from "@kubernetes/client-node";
import { randomBytes, randomUUID } from "crypto";
import net from "net";
import { Writable } from "stream";
import { getEggForGameType, type GameEgg, type SavedCommand } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, parseEggConfig } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";
import { UserError } from "@/lib/utils";

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

// A HorizontalPodAutoscaler reconciles the Deployment back up to its minReplicas
// the instant we scale to 0, which makes a stopped server auto-restart
// (stopped → starting → running). Remove it first so the stop sticks — this
// mirrors how the "scale" action drops the HPA before changing replicas.
// A missing HPA (404) or absent client is a harmless no-op.
export async function removeServerAutoscaler(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
) {
  try {
    await clients.autoscalingApi?.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NS });
  } catch {
    // No autoscaler attached (or already removed) — nothing to clean up.
  }
}

export async function gracefulStopServer(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
  stopCommand: string | null | undefined,
  _timeoutMs = 30_000, // kept for API compat
) {
  void _timeoutMs;
  const pod = await getServerPod(clients.coreApi, name, true).catch(() => null);
  const containerName = getPrimaryContainerName(pod, name);
  let stopCommandSent = false;

  if (pod?.metadata?.name && stopCommand?.trim()) {
    try {
      await sendConsoleInputViaExec(clients.kc, pod.metadata.name, containerName, stopCommand.trim(), 8_000);
      stopCommandSent = true;
    } catch {
      stopCommandSent = false;
    }
  }

  await removeServerAutoscaler(clients, name);
  await scaleServerWorkload(clients.appsApi, name, 0);

  // NOTE: we intentionally do NOT block here waiting for the pod to terminate.
  // A synchronous poll loop made the stop request take ~20s, long enough for the
  // browser/proxy to abort it ("TypeError: Failed to fetch"). Scaling to 0 has
  // already issued the shutdown; the UI polls server status every 15s and will
  // reflect the stopped state on the next refresh.
  return { stopCommandSent, exitedGracefully: stopCommandSent };
}

export async function forceStopServer(
  clients: ReturnType<typeof makeGameHubClients>,
  name: string,
) {
  const pods = await clients.coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
  await removeServerAutoscaler(clients, name);
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
