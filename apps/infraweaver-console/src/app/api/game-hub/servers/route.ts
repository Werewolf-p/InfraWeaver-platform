import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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

const createServerBodySchema = z.object({
  action: z.enum(["clone"]).optional(),
  source: z.string().optional(),
  newName: z.string().optional(),
  egg: z.string().optional(),
  game: z.string().optional(),
  gameId: z.string().optional(),
  name: z.string().min(1),
  dnsHostname: z.string().optional(),
  image: z.string().optional(),
  memory: z.string().optional(),
  cpu: z.string().optional(),
  storage: z.string().optional(),
  storageClass: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  port: z.number().optional(),
  ports: z.array(z.object({ name: z.string(), port: z.number(), protocol: z.enum(["TCP", "UDP"]) })).optional(),
  mountPath: z.string().optional(),
});

function pvcSuffixForMountPath(mountPath: string) {
  return (mountPath.split("/").filter(Boolean).pop() ?? "data").replace(/[^a-z0-9-]/g, "-") || "data";
}

/**
 * Sanitize a value to be safe for use as a Kubernetes label value.
 * Must match: (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])? — max 63 chars.
 */
function sanitizeLabelValue(value: string): string {
  // Replace anything not alphanumeric, hyphen, underscore, or dot with a hyphen
  let sanitized = value.replace(/[^A-Za-z0-9\-_.]/g, "-");
  // Collapse consecutive hyphens
  sanitized = sanitized.replace(/-{2,}/g, "-");
  // Strip leading/trailing non-alphanumeric characters
  sanitized = sanitized.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
  // Truncate to 63 chars
  sanitized = sanitized.slice(0, 63);
  // If empty after sanitization, fall back to "unknown"
  return sanitized || "unknown";
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

const SIGNAL_MAP: Record<string, number> = { "^C": 2, "^Z": 19, "^\\": 3 };

/**
 * 3-tier graceful shutdown spec for game server pods.
 *
 * Tier 1 — RCON: when RCON_PORT is present in the egg env, uses the Source RCON
 *           protocol implemented in pure Python3 (no extra images needed) to send
 *           the stop command over TCP. ACK-confirmed — the server processes the
 *           command before the pod exits.
 *
 * Tier 2 — stdin write: for text stop commands (e.g. "stop", "exit", "quit"),
 *           uses shareProcessNamespace + TTY to write the command directly to the
 *           game process stdin. Equivalent to typing in the server console.
 *
 * Tier 3 — signal: SIGINT (or mapped control-char signal) sent to the game process
 *           located via /proc scan. Universal last resort; most game servers handle
 *           SIGINT gracefully.
 *
 * Returns the lifecycle hook and extra env vars (prefixed _IW_) to inject into the
 * game container so the preStop script can read them.
 */
function buildStopSpec(
  stopCommand: string | undefined,
  env: Record<string, string>,
): {
  lifecycleHook: { preStop: { exec: { command: string[] } } };
  extraEnv: Record<string, string>;
} {
  const sig = stopCommand ? (SIGNAL_MAP[stopCommand] ?? 2) : 2;
  const isText = stopCommand ? !(stopCommand in SIGNAL_MAP) : false;
  const hasRcon = Boolean(env["RCON_PORT"]);

  const extraEnv: Record<string, string> = {
    _IW_STOP_SIGNAL: String(sig),
    _IW_STOP_CMD: isText ? stopCommand! : "stop",
    ...(isText ? { _IW_STOP_STDIN: "1" } : {}),
  };

  // Source RCON protocol in ~10 lines of Python3. All strings use double quotes
  // so the code can be safely wrapped in shell single-quotes without escaping.
  // bytes(2) produces b'\x00\x00' (the RCON packet terminator).
  const pythonRcon = [
    "import socket,struct,os,sys",
    "try:",
    " s=socket.socket();s.settimeout(5)",
    " s.connect((\"127.0.0.1\",int(os.environ.get(\"RCON_PORT\",\"25575\"))))",
    " pw=(os.environ.get(\"RCON_PASSWORD\") or os.environ.get(\"RCON_PASS\") or \"\").encode()",
    " cmd=os.environ.get(\"_IW_STOP_CMD\",\"stop\").encode()",
    " def p(i,t,b):d=struct.pack(\"<ii\",i,t)+b+bytes(2);return struct.pack(\"<i\",len(d))+d",
    " s.sendall(p(1,3,pw));r=s.recv(4096)",
    " if len(r)>=12 and struct.unpack(\"<i\",r[4:8])[0]==-1:sys.exit(1)",
    " s.sendall(p(2,2,cmd));s.recv(4096);s.close();sys.exit(0)",
    "except:sys.exit(1)",
  ].join("\n");

  // Locate the game process PID via /proc scan (visible via shareProcessNamespace).
  // Skips infrastructure processes that are never the game server.
  const findPid = [
    "GPID=\"\"",
    "for _P in $(ls /proc 2>/dev/null | grep '^[0-9]'); do",
    "  _C=$(cat /proc/$_P/comm 2>/dev/null)",
    "  case \"$_C\" in pause|sh|bash|sleep|init|tini|python3|\"\") continue;; esac",
    "  GPID=$_P; break",
    "done",
  ].join("\n");

  const tiers: string[] = [
    "# Locate game process once — used by all fallback tiers",
    findPid,
  ];

  if (hasRcon) {
    tiers.push(
      "# Tier 1: RCON — ACK-confirmed stop via Source RCON protocol (Python3)",
      "if [ -n \"${RCON_PORT}\" ] && command -v python3 >/dev/null 2>&1; then",
      "  python3 -c '" + pythonRcon + "' 2>/dev/null && sleep 10 && exit 0",
      "fi",
    );
  }

  if (isText) {
    tiers.push(
      "# Tier 2: stdin write via shared PID namespace + TTY",
      "if [ \"${_IW_STOP_STDIN:-0}\" = \"1\" ] && [ -n \"$GPID\" ]; then",
      "  printf '%s\\n' \"${_IW_STOP_CMD}\" >/proc/$GPID/fd/0 2>/dev/null && sleep 15 && exit 0",
      "fi",
    );
  }

  tiers.push(
    "# Tier 3: signal fallback",
    "kill -${_IW_STOP_SIGNAL:-2} ${GPID:-1} 2>/dev/null || true",
    "sleep 5",
  );

  return {
    lifecycleHook: {
      preStop: {
        exec: { command: ["/bin/sh", "-c", tiers.join("\n")] },
      },
    },
    extraEnv,
  };
}

/**
 * Builds an init container that runs the Pelican installation script once.
 *
 * ALL Pelican/Pterodactyl install scripts write game files to /mnt/server —
 * that path is hardcoded by convention in every egg from the pelican-eggs repo.
 * The main game container then mounts the same PVC at its own mountPath
 * (e.g. /home/container for yolks images).  Both containers share the same
 * underlying storage via the "data" volume, just mounted at different paths.
 *
 * A marker file (.installed) is written to /mnt/server on first completion so
 * subsequent pod restarts skip the re-download step.
 */
function buildInstallInitContainer(
  _runtimeMountPath: string,
  installScript: { script: string; container: string; entrypoint: string },
  env: Record<string, string>,
  isRoot: boolean,
) {
  // Pelican install scripts always write to /mnt/server — mount the PVC there.
  const INSTALL_MOUNT = "/mnt/server";

  const wrappedScript = [
    "#!/bin/sh",
    `if [ -f "${INSTALL_MOUNT}/.installed" ]; then`,
    '  echo "[install] Already installed — skipping"',
    "  exit 0",
    "fi",
    installScript.script,
    `touch "${INSTALL_MOUNT}/.installed"`,
    'echo "[install] Installation complete"',
  ].join("\n");

  return {
    name: "installer",
    image: installScript.container,
    command: [installScript.entrypoint, "-c", wrappedScript],
    env: Object.entries(env).map(([key, value]) => ({ name: key, value })),
    securityContext: isRoot ? { runAsUser: 0, runAsGroup: 0 } : { runAsUser: 1000, runAsGroup: 1000 },
    // Mount at /mnt/server so the Pelican install script can find its target dir.
    volumeMounts: [{ name: "data", mountPath: INSTALL_MOUNT }],
    // Installation can be slow (SteamCMD downloads, large assets) — be generous.
    resources: {
      requests: { cpu: "200m", memory: "512Mi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
  };
}

async function createServer(body: {
  egg?: string;
  game?: string;
  gameId?: string;
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
  const requestedGame = body.egg ?? body.gameId ?? body.game ?? "";
  const slug = normalizeServerName(body.name);
  const baseEgg = requestedGame.startsWith("pelican:")
    ? (await getPelicanGameEgg(requestedGame.replace(/^pelican:/, ""))).egg
    : getEggForGameType(requestedGame);
  const customPorts = body.ports?.length ? body.ports : undefined;
  const eggId = requestedGame.startsWith("pelican:") ? baseEgg.id : (requestedGame || baseEgg.id);
  // Safe label value — Pelican IDs can contain '/', '[', ']' etc. which K8s rejects
  const eggLabel = sanitizeLabelValue(eggId);
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
  const storageClass = body.storageClass ?? "longhorn-game";
  const pvcName = `${slug}-${pvcSuffixForMountPath(egg.mountPath)}`;
  const imageVersion = parseImageVersion(egg.dockerImage);
  const baseDomain = process.env.BASE_DOMAIN ?? "local";
  const dnsHostname = typeof body.dnsHostname === "string" ? body.dnsHostname.trim().toLowerCase() : `${slug}.games.int.${baseDomain}`;
  const annotations = {
    "infraweaver.io/groups": (body.groups ?? []).join(","),
    "infraweaver.io/image-version": imageVersion.version,
    "infraweaver.io/last-started": new Date().toISOString(),
    // Store the original unmodified egg ID in an annotation (no char restrictions)
    "infraweaver.io/egg-id": eggId,
    ...(dnsHostname ? { "infraweaver.io/dns-hostname": dnsHostname } : {}),
    ...(requestedGame.startsWith("pelican:") ? { "infraweaver.io/egg-source": requestedGame } : {}),
  };

  const resources = buildGameServerResources(memory, cpu);
  const { appsApi, coreApi } = makeGameHubClients();
  const isRoot = egg.features?.includes("run_as_root") ?? false;

  // Pelican yolk images read a STARTUP env var and run it via their entrypoint.
  // Always set STARTUP so yolk-compatible images apply the correct launch command.
  const gameEnv: Record<string, string> = {
    ...env,
    ...(egg.startupCommand ? { STARTUP: egg.startupCommand } : {}),
  };

  // Build 3-tier stop spec (RCON → stdin → signal). Extra env vars it needs are
  // merged into the container env so the preStop script can read them at runtime.
  const stopSpec = buildStopSpec(egg.stopCommand, gameEnv);
  const allEnv: Record<string, string> = { ...gameEnv, ...stopSpec.extraEnv };

  // Build init container if the egg ships an installation script.
  const installInitContainer = egg.installScript
    ? buildInstallInitContainer(egg.mountPath, egg.installScript, allEnv, isRoot)
    : null;

  // Heavy games (installs take >10 min) get extra startup time.
  const isHeavy = (egg.defaultStorage ?? "10Gi") >= "20Gi" || (egg.defaultMemory ?? "2Gi") >= "4Gi";
  const startupMinutes = isHeavy ? 20 : 10;

  await coreApi.createNamespacedPersistentVolumeClaim({
    namespace: GAME_HUB_NAMESPACE,
    body: {
      metadata: { name: pvcName, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true", "infraweaver/egg": eggLabel, "infraweaver.io/egg": eggLabel } },
      spec: { accessModes: ["ReadWriteOnce"], storageClassName: storageClass, resources: { requests: { storage } } },
    },
  });

  await appsApi.createNamespacedDeployment({
    namespace: GAME_HUB_NAMESPACE,
    body: {
      metadata: { name: slug, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true", "infraweaver/game-type": eggLabel, "infraweaver.io/game-type": eggLabel, "infraweaver/egg": eggLabel, "infraweaver.io/egg": eggLabel }, annotations },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: slug } },
        template: {
          metadata: { labels: { app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true", "infraweaver/game-type": eggLabel, "infraweaver.io/game-type": eggLabel, "infraweaver/egg": eggLabel, "infraweaver.io/egg": eggLabel }, annotations },
          spec: {
            priorityClassName: "game-server",
            terminationGracePeriodSeconds: 120,
            shareProcessNamespace: true,
            topologySpreadConstraints: [{
              maxSkew: 1,
              topologyKey: "kubernetes.io/hostname",
              whenUnsatisfiable: "ScheduleAnyway",
              labelSelector: { matchLabels: { "infraweaver/game": "true" } },
            }],
            securityContext: isRoot ? { runAsUser: 0, runAsGroup: 0 } : { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
            ...(installInitContainer ? { initContainers: [installInitContainer] } : {}),
            containers: [{
              name: slug,
              image: egg.dockerImage,
              imagePullPolicy: "IfNotPresent",
              stdin: true,
              tty: true,
              ports: getEggPorts(egg).map((port) => ({ containerPort: port.port, protocol: port.protocol })),
              env: Object.entries(allEnv).map(([key, value]) => ({ name: key, value })),
              resources,
              volumeMounts: [{ name: "data", mountPath: egg.mountPath }],
              lifecycle: stopSpec.lifecycleHook,
              ...buildUniversalGameServerProbes(startupMinutes),
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

  return { name: slug, game: egg.id, gameId: egg.id, status: "creating" };
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
  const baseDomainClone = process.env.BASE_DOMAIN ?? "local";
  const dnsHostname = `${slug}.games.int.${baseDomainClone}`;

  await coreApi.createNamespacedPersistentVolumeClaim({
    namespace: GAME_HUB_NAMESPACE,
    body: {
      metadata: { name: pvcName, namespace: GAME_HUB_NAMESPACE, labels: { app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true", "infraweaver/egg": sanitizeLabelValue(sourceEgg.id), "infraweaver.io/egg": sanitizeLabelValue(sourceEgg.id) } },
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
        labels: { ...(sourceDeployment.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true" },
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
            labels: { ...(sourceDeployment.spec?.template?.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true" },
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
              stdin: true,  // required: lets /proc/1/fd/0 work for in-pod console commands
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
        labels: { ...(sourceService.metadata?.labels ?? {}), app: slug, "infraweaver/game": "true", "infraweaver.io/game": "true" },
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
      const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? deployment.metadata?.labels?.["infraweaver.io/game-type"] ?? "unknown";
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

    return NextResponse.json({ servers, setupRequired: false });
  } catch (error) {
    // Detect "namespace not found" (k8s 404) — namespace hasn't been set up yet
    const k8sCode = (error as { statusCode?: number; body?: { code?: number; reason?: string } })?.statusCode
      ?? (error as { body?: { code?: number } })?.body?.code;
    const k8sReason = (error as { body?: { reason?: string } })?.body?.reason;

    if (k8sCode === 404 || k8sReason === "NotFound") {
      return NextResponse.json({ servers: [], setupRequired: true, reason: "namespace_missing" });
    }
    if (k8sCode === 403 || k8sReason === "Forbidden") {
      return NextResponse.json({ servers: [], setupRequired: true, reason: "permission_denied" });
    }

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
    const rawBody = await req.json().catch(() => ({}));
    const parsed = createServerBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;

    if (body.action === "clone") {
      if (!body.source || !body.newName) {
        return NextResponse.json({ error: "source and newName are required" }, { status: 400 });
      }
      const result = await cloneServer(body.source, body.newName);
      await auditLog("game-hub:clone", session.user?.email ?? "unknown", `${body.source} -> ${result.name}`);

      try {
        await writeServerManifest(result.name, makeGameHubClients());
      } catch (gitErr) {
        // K8s objects were created successfully. Git backing failed — ArgoCD will not track
        // this server until a manual writeServerManifest is triggered or the server is edited.
        console.error(`writeServerManifest failed after clone of ${result.name}:`, gitErr);
        return NextResponse.json({ ...result, warning: "Server created but git sync failed — IAC backing is incomplete" }, { status: 201 });
      }

      return NextResponse.json(result, { status: 201 });
    }

    const result = await createServer(body);
    await auditLog("game-hub:create", session.user?.email ?? "unknown", `created ${result.name}`);

    try {
      await writeServerManifest(result.name, makeGameHubClients());
    } catch (gitErr) {
      console.error(`writeServerManifest failed after create of ${result.name}:`, gitErr);
      return NextResponse.json({ ...result, warning: "Server created but git sync failed — IAC backing is incomplete" }, { status: 201 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("game hub server create failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
