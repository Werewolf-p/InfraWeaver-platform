import { execShell, getPrimaryContainerName, getServerDeployment, getServerPod, makeGameHubClients, readServerEgg } from "@/lib/game-hub-server";
import { resolveServerDataRoot } from "./data-root";

type Clients = ReturnType<typeof makeGameHubClients>;

// The offline file pod self-deletes after this window even if a handler crashes
// before its cleanup runs — a safety net against leaked pods.
const OFFLINE_POD_TTL_SECONDS = 300;
const GAME_HUB_NS = "game-hub";

// Whether the operation only reads the volume or also writes to it. Reads mount
// the PVC read-only so a read-only user never spins a writable pod over the save
// data; only write verbs mount it read-write.
export type FileExecMode = "read" | "write";

export interface ServerFileExec {
  rootPath: string;
  offline: boolean;
  exec: (script: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;
}

// Per-server in-process mutex. The offline pod has a deterministic name
// (`<server>-files`), so without serialization two concurrent requests would
// delete each other's pod mid-exec. Each server's work is chained so only one
// offline operation per server runs at a time within this process.
const serverLocks = new Map<string, Promise<void>>();

async function withServerLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = serverLocks.get(name) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The next caller waits for `gate` regardless of how our work settled.
  const chain = previous.then(() => gate, () => gate);
  serverLocks.set(name, chain);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    // If nobody queued behind us, drop the key so the map does not grow forever.
    if (serverLocks.get(name) === chain) serverLocks.delete(name);
  }
}

async function waitForPodRunning(clients: Clients, podName: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await clients.coreApi.readNamespacedPod({ name: podName, namespace: GAME_HUB_NS }).catch(() => null);
    const phase = pod?.status?.phase;
    if (phase === "Running" && (pod?.status?.containerStatuses ?? []).some((cs) => cs.state?.running != null)) return;
    if (phase === "Failed" || phase === "Succeeded") throw new Error(`offline file pod ${phase}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out starting the offline file pod");
}

async function waitForPodGone(clients: Clients, podName: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exists = await clients.coreApi.readNamespacedPod({ name: podName, namespace: GAME_HUB_NS }).then(() => true).catch(() => false);
    if (!exists) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // Don't fall through to createNamespacedPod while the old pod lingers — that
  // would fail with AlreadyExists and leak the request.
  throw new Error("Timed out deleting the stale offline file pod");
}

async function deletePod(clients: Clients, podName: string) {
  await clients.coreApi
    .deleteNamespacedPod({ name: podName, namespace: GAME_HUB_NS, gracePeriodSeconds: 0, body: { gracePeriodSeconds: 0 } })
    .catch(() => undefined);
}

/**
 * Runs a file operation against a game server's data whether the server is
 * online or stopped.
 *
 * Online: execs into the running game pod. Offline (scaled to 0): spins a
 * short-lived pod that mounts the data PVC, runs the operation, then tears the
 * pod down. Editing while the server is stopped is safe — the game process is
 * not running, so there is no race against it for the save files.
 *
 * `mode` controls how the offline pod mounts the volume: `"read"` mounts it
 * read-only, `"write"` mounts it read-write. The callback receives `rootPath`
 * (the data directory to validate paths against), `offline`, and an
 * `exec(script)` that runs a shell command in the right pod. Callers own path
 * validation; this helper owns pod lifecycle.
 */
export async function withServerFileExec<T>(
  clients: Clients,
  name: string,
  mode: FileExecMode,
  fn: (ctx: ServerFileExec) => Promise<T>,
): Promise<T> {
  const pod = await getServerPod(clients.coreApi, name, true);
  if (pod?.metadata?.name) {
    const rootPath = await resolveServerDataRoot(clients, name, pod);
    const podName = pod.metadata.name;
    const containerName = getPrimaryContainerName(pod, name);
    return fn({
      rootPath,
      offline: false,
      exec: (script, timeoutMs) => execShell(clients.kc, podName, containerName, script, timeoutMs),
    });
  }

  // Offline path creates a pod under a deterministic name and contends for the
  // RWO volume, so serialize per server within this process.
  return withServerLock(name, () => runOfflineFileExec(clients, name, mode, fn));
}

async function runOfflineFileExec<T>(
  clients: Clients,
  name: string,
  mode: FileExecMode,
  fn: (ctx: ServerFileExec) => Promise<T>,
): Promise<T> {
  const deployment = await getServerDeployment(clients.appsApi, name).catch(() => null);
  if (!deployment) throw new Error("Server not found");
  // If the deployment is not scaled to 0 the server is starting (its pod just
  // is not Running yet). Mounting the RWO volume now would block that pod from
  // scheduling, so refuse rather than race the server for its own storage.
  if ((deployment.spec?.replicas ?? 1) !== 0) {
    throw new Error("Server is starting or running — stop it before browsing files offline");
  }
  const pvcName = deployment.spec?.template?.spec?.volumes?.find(
    (volume) => volume.persistentVolumeClaim?.claimName,
  )?.persistentVolumeClaim?.claimName;
  if (!pvcName) throw new Error("Server has no persistent storage to browse");

  const egg = await readServerEgg(clients.coreApi, name, deployment);
  const rootPath = egg.mountPath || "/data";
  // Reuse the server's own image (already cached on the node) so there is no
  // image pull while the server is offline.
  const image = deployment.spec?.template?.spec?.containers?.[0]?.image ?? egg.dockerImage;
  const podName = `${name}-files`.slice(0, 63);
  const readOnly = mode === "read";

  await ensureOfflineFilePod(clients, { podName, name, image, rootPath, pvcName, deployment, readOnly });

  try {
    await waitForPodRunning(clients, podName);
    return await fn({
      rootPath,
      offline: true,
      exec: (script, timeoutMs) => execShell(clients.kc, podName, "reader", script, timeoutMs),
    });
  } finally {
    await deletePod(clients, podName);
  }
}

interface OfflineFilePodSpec {
  podName: string;
  name: string;
  image: string | undefined;
  rootPath: string;
  pvcName: string;
  deployment: Awaited<ReturnType<typeof getServerDeployment>>;
  readOnly: boolean;
}

/**
 * Brings up the offline file pod, reusing a healthy existing one when its mount
 * mode can serve this request instead of unconditionally deleting and
 * recreating it. A read-write pod can serve reads; a read-only pod cannot serve
 * writes, so it is torn down and recreated read-write.
 */
async function ensureOfflineFilePod(clients: Clients, spec: OfflineFilePodSpec) {
  const { podName, name, image, rootPath, pvcName, deployment, readOnly } = spec;

  const existing = await clients.coreApi
    .readNamespacedPod({ name: podName, namespace: GAME_HUB_NS })
    .catch(() => null);
  if (existing) {
    const running =
      existing.status?.phase === "Running" &&
      (existing.status?.containerStatuses ?? []).some((cs) => cs.state?.running != null);
    const mountReadOnly = existing.spec?.containers?.[0]?.volumeMounts?.find(
      (mount) => mount.name === "data",
    )?.readOnly === true;
    const modeCompatible = readOnly || !mountReadOnly;
    if (running && modeCompatible) return;
    // Stale, failed, or mounted with the wrong access mode — replace it.
    await deletePod(clients, podName);
    await waitForPodGone(clients, podName);
  }

  await clients.coreApi.createNamespacedPod({
    namespace: GAME_HUB_NS,
    body: {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: GAME_HUB_NS,
        labels: { "infraweaver/game": "true", "infraweaver/type": "file-ops", "infraweaver.io/server": name },
      },
      spec: {
        restartPolicy: "Never",
        activeDeadlineSeconds: OFFLINE_POD_TTL_SECONDS,
        // This pod never talks to the Kubernetes API — don't mount an SA token,
        // so a file-browser path-traversal bug can't exfiltrate cluster
        // credentials from it. Defense-in-depth for SECURITY-AUDIT H1.
        automountServiceAccountToken: false,
        securityContext: deployment?.spec?.template?.spec?.securityContext,
        containers: [
          {
            name: "reader",
            image,
            command: ["sh", "-c", `sleep ${OFFLINE_POD_TTL_SECONDS}`],
            volumeMounts: [{ name: "data", mountPath: rootPath, readOnly }],
          },
        ],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: pvcName } }],
      },
    },
  });
}
