/**
 * game-hub-manifest.ts
 * Generates Kubernetes YAML manifests for Game Hub servers and writes them to git.
 * This keeps the cluster rebuild reproducible — every server created via the UI
 * is committed to kubernetes/catalog/game-hub/servers/{name}.yaml and tracked by
 * the catalog-game-hub-servers ArgoCD Application.
 */

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GIT_PATH_PREFIX = "kubernetes/catalog/game-hub/servers";

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function ghGet(path: string): Promise<unknown> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
      cache: "no-store",
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json();
}

async function ghPut(
  path: string,
  content: string,
  message: string,
  sha?: string,
): Promise<unknown> {
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(`GitHub PUT ${path}: ${res.status} — ${await res.text()}`);
  return res.json();
}

async function ghDelete(path: string, message: string, sha: string): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        sha,
        committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
      }),
    },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub DELETE ${path}: ${res.status}`);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GameServerManifestOptions {
  /** Server name — DNS-safe slug, e.g. "terraria-server" */
  name: string;
  /** Always "game-hub" */
  namespace: string;
  /** Docker image, e.g. "itzg/minecraft-server:latest" */
  image: string;
  /** Default 1 */
  replicas?: number;
  resources?: {
    cpu?: string;
    memory?: string;
    cpuRequest?: string;
    memoryRequest?: string;
  };
  /** Exposed container port numbers */
  ports?: number[];
  /** Storage request in Gi, default 10 */
  pvcSizeGi?: number;
  /** Storage class name, default "longhorn" */
  storageClass?: string;
  /** Volume mount path inside the container, default "/data" */
  mountPath?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Egg ConfigMap content — included when egg data is available */
  eggData?: {
    startup_command?: string;
    stop_command?: string;
    quick_commands?: Array<{ label: string; command?: string; cmd?: string }>;
    game_port?: number;
    query_port?: number;
  };
  /** Extra Deployment annotations (infraweaver/icon, tags, description, etc.) */
  annotations?: Record<string, string>;
}

// ─── YAML generation helpers ──────────────────────────────────────────────────

/** Escape a string for use as a YAML double-quoted scalar. */
function yamlStr(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Render a flat key→string map as YAML mapping lines, indented by `indent` spaces. */
function yamlStringMap(map: Record<string, string>, indent: number): string {
  const pad = " ".repeat(indent);
  return Object.entries(map)
    .map(([k, v]) => `${pad}${k}: ${yamlStr(v)}`)
    .join("\n");
}

/** Convert a storage string like "10Gi", "512Mi" to a Gi number for the manifest. */
export function parsePvcSizeGi(storage: string): number {
  const gi = storage.match(/^(\d+(?:\.\d+)?)Gi$/i);
  if (gi) return Math.max(1, Math.round(parseFloat(gi[1])));
  const mi = storage.match(/^(\d+)Mi$/i);
  if (mi) return Math.max(1, Math.ceil(parseInt(mi[1], 10) / 1024));
  const plain = storage.match(/^(\d+)$/);
  if (plain) return Math.max(1, Math.ceil(parseInt(plain[1], 10) / (1024 ** 3)));
  return 10;
}

// ─── Manifest generation ──────────────────────────────────────────────────────

/**
 * Generate a complete multi-document YAML manifest for a game server.
 * Document order: Namespace → (optional) ConfigMap/egg → PVC → Deployment → Service
 */
export function generateGameServerManifest(opts: GameServerManifestOptions): string {
  const name = opts.name;
  const ns = opts.namespace;
  const image = opts.image;
  const replicas = opts.replicas ?? 1;
  const pvcName = `${name}-data`;
  const pvcSize = `${opts.pvcSizeGi ?? 10}Gi`;
  const storageClass = opts.storageClass ?? "longhorn";
  const mountPath = opts.mountPath ?? "/data";
  const memLimit = opts.resources?.memory ?? "2Gi";
  const cpuLimit = opts.resources?.cpu ?? "1";
  const memRequest = opts.resources?.memoryRequest ?? "512Mi";
  const cpuRequest = opts.resources?.cpuRequest ?? "250m";
  const ports = opts.ports?.length ? opts.ports : [25565];
  const env = opts.env ?? {};
  const annotations = opts.annotations ?? {};

  const docs: string[] = [];

  // ── 1. Namespace ─────────────────────────────────────────────────────────────
  docs.push(`apiVersion: v1
kind: Namespace
metadata:
  name: ${ns}
  labels:
    infraweaver/managed: "true"
    infraweaver/game-hub: "true"`);

  // ── 2. Egg ConfigMap (optional) ───────────────────────────────────────────────
  if (opts.eggData) {
    const egg = opts.eggData;
    const quickCmds = egg.quick_commands?.length
      ? `\n  quick_commands: ${yamlStr(JSON.stringify(egg.quick_commands))}`
      : "";
    const queryPortLine = egg.query_port
      ? `\n  query_port: ${yamlStr(String(egg.query_port))}`
      : "";
    docs.push(`apiVersion: v1
kind: ConfigMap
metadata:
  name: gameserver-${name}-egg
  namespace: ${ns}
  labels:
    app: ${name}
    infraweaver/game: "true"
    infraweaver/type: egg-config
data:
  startup_command: ${yamlStr(egg.startup_command ?? "")}
  stop_command: ${yamlStr(egg.stop_command ?? "")}
  game_port: ${yamlStr(String(egg.game_port ?? ports[0] ?? 25565))}${queryPortLine}${quickCmds}`);
  }

  // ── 3. PersistentVolumeClaim ──────────────────────────────────────────────────
  docs.push(`apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: ${ns}
  labels:
    app: ${name}
    infraweaver/game: "true"
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: ${pvcSize}`);

  // ── 4. Deployment ─────────────────────────────────────────────────────────────
  const annotationLines = Object.entries(annotations).length > 0
    ? `\n  annotations:\n${yamlStringMap(annotations, 4)}`
    : "";

  const envLines = Object.entries(env).length > 0
    ? "\n          env:\n" +
      Object.entries(env)
        .map(([k, v]) => `            - name: ${k}\n              value: ${yamlStr(v)}`)
        .join("\n")
    : "";

  const portLines = ports
    .map((p, i) => `            - containerPort: ${p}\n              protocol: TCP\n              name: port${i === 0 ? "-game" : `-${i}`}`)
    .join("\n");

  const primaryPort = ports[0] ?? 25565;

  docs.push(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    infraweaver/game: "true"${annotationLines}
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${name}
  template:
    metadata:
      labels:
        app: ${name}
        infraweaver/game: "true"
    spec:
      containers:
        - name: ${name}
          image: ${image}
          ports:
${portLines}${envLines}
          resources:
            requests:
              memory: ${memRequest}
              cpu: ${cpuRequest}
            limits:
              memory: ${memLimit}
              cpu: ${cpuLimit}
          volumeMounts:
            - name: data
              mountPath: ${mountPath}
          livenessProbe:
            tcpSocket:
              port: ${primaryPort}
            initialDelaySeconds: 120
            periodSeconds: 30
            failureThreshold: 5
          readinessProbe:
            tcpSocket:
              port: ${primaryPort}
            initialDelaySeconds: 90
            periodSeconds: 20
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${pvcName}`);

  // ── 5. Service ────────────────────────────────────────────────────────────────
  const svcPortLines = ports
    .map((p, i) => `    - port: ${p}\n      targetPort: ${p}\n      protocol: TCP\n      name: port${i === 0 ? "-game" : `-${i}`}`)
    .join("\n");

  docs.push(`apiVersion: v1
kind: Service
metadata:
  name: ${name}
  namespace: ${ns}
  labels:
    app: ${name}
    infraweaver/game: "true"
spec:
  type: NodePort
  selector:
    app: ${name}
  ports:
${svcPortLines}`);

  return docs.map((doc) => `---\n${doc}\n`).join("");
}

// ─── Git write-back operations ────────────────────────────────────────────────

/** Get the current git SHA for a server manifest (needed for updates). */
export async function getGameServerManifestSha(name: string): Promise<string | null> {
  const path = `${GIT_PATH_PREFIX}/${name}.yaml`;
  const result = await ghGet(path) as null | { sha: string };
  return result?.sha ?? null;
}

/**
 * Write a game server manifest to git.
 * Creates or updates kubernetes/catalog/game-hub/servers/{name}.yaml
 */
export async function writeGameServerManifest(name: string, yaml: string): Promise<void> {
  const path = `${GIT_PATH_PREFIX}/${name}.yaml`;
  const existing = await ghGet(path) as null | { sha: string };
  const sha = existing?.sha;
  const verb = sha ? "update" : "add";
  await ghPut(
    path,
    yaml,
    `feat(game-hub): ${verb} manifest for ${name}`,
    sha,
  );
}

/**
 * Delete a game server manifest from git.
 * Removes kubernetes/catalog/game-hub/servers/{name}.yaml
 * Silently succeeds if the file does not exist.
 */
export async function deleteGameServerManifest(name: string): Promise<void> {
  const path = `${GIT_PATH_PREFIX}/${name}.yaml`;
  const existing = await ghGet(path) as null | { sha: string };
  if (!existing?.sha) return; // already gone
  await ghDelete(path, `feat(game-hub): remove manifest for ${name}`, existing.sha);
}
