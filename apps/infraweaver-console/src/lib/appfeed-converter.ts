/**
 * appfeed-converter.ts
 *
 * Converts Unraid Community Applications AppFeed entries into Kubernetes manifests.
 *
 * Unraid → K8s mapping:
 *   Config Type "Variable" → env[] in Deployment
 *   Config Type "Port"     → containerPorts[] + ClusterIP Service
 *   Config Type "Path"     → volumeMounts[] + PVC / hostPath / emptyDir (classified)
 *   Config Type "Device"   → securityContext.privileged (flagged as complex)
 *   Network: host          → hostNetwork: true
 *   Privileged: true       → securityContext.privileged: true
 *   WebUI field            → port extracted for Traefik IngressRoute
 *   ExtraParams            → capabilities, sysctls, runAsUser, memory limits
 */

import { UserError } from "./utils";

export type K8sCompatTier = "simple" | "medium" | "complex";

type ResourceProfile = {
  memReq: string;
  memLimit: string;
  cpuReq: string;
  cpuLimit: string;
};

const TIER_RESOURCE_PROFILES: Record<K8sCompatTier, ResourceProfile> = {
  simple: { memReq: "64Mi", memLimit: "512Mi", cpuReq: "50m", cpuLimit: "500m" },
  medium: { memReq: "128Mi", memLimit: "2Gi", cpuReq: "100m", cpuLimit: "1000m" },
  complex: { memReq: "256Mi", memLimit: "4Gi", cpuReq: "250m", cpuLimit: "2000m" },
};

const KNOWN_HEAVY_APPS: Record<string, ResourceProfile> = {
  photoprism: { memReq: "1Gi", memLimit: "4Gi", cpuReq: "500m", cpuLimit: "2000m" },
  nextcloud: { memReq: "256Mi", memLimit: "2Gi", cpuReq: "250m", cpuLimit: "2000m" },
  jellyfin: { memReq: "256Mi", memLimit: "4Gi", cpuReq: "500m", cpuLimit: "4000m" },
  plex: { memReq: "512Mi", memLimit: "4Gi", cpuReq: "1000m", cpuLimit: "4000m" },
  gitea: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  vaultwarden: { memReq: "64Mi", memLimit: "256Mi", cpuReq: "50m", cpuLimit: "500m" },
  "uptime-kuma": { memReq: "64Mi", memLimit: "512Mi", cpuReq: "50m", cpuLimit: "500m" },
  filebrowser: { memReq: "64Mi", memLimit: "256Mi", cpuReq: "50m", cpuLimit: "250m" },
  homepage: { memReq: "64Mi", memLimit: "256Mi", cpuReq: "50m", cpuLimit: "250m" },
  grafana: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  mysql: { memReq: "256Mi", memLimit: "2Gi", cpuReq: "250m", cpuLimit: "2000m" },
  postgresql18: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  postgresql17: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  postgresql16: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  mariadb: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
  mongodb: { memReq: "256Mi", memLimit: "2Gi", cpuReq: "250m", cpuLimit: "2000m" },
  elasticsearch: { memReq: "512Mi", memLimit: "4Gi", cpuReq: "500m", cpuLimit: "2000m" },
  gitlab: { memReq: "2Gi", memLimit: "8Gi", cpuReq: "1000m", cpuLimit: "4000m" },
  sonarqube: { memReq: "1Gi", memLimit: "4Gi", cpuReq: "500m", cpuLimit: "2000m" },
  n8n: { memReq: "128Mi", memLimit: "1Gi", cpuReq: "100m", cpuLimit: "1000m" },
};

// ── host path classification ──────────────────────────────────────────────────

/** Container-runtime sockets / OS virtual filesystems — skip (never create PVCs). */
const RUNTIME_SKIP_PATHS: string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/podman.sock",
  "/proc",
  "/sys/fs/cgroup",
];

/** OS paths that should be mounted read-only from the host (not PVCs). */
const HOST_PATH_RO: string[] = [
  "/lib/modules",
  "/lib/firmware",
  "/usr/lib/modules",
  "/etc/localtime",
  "/etc/timezone",
];

/** Paths that should be emptyDir (ephemeral scratch — not persisted). */
const EMPTY_DIR_MOUNTS: { prefix: string; medium?: "Memory" }[] = [
  { prefix: "/tmp" },
  { prefix: "/dev/shm", medium: "Memory" },
  { prefix: "/run/lock" },
];

/**
 * Large media / data-sink paths that in Unraid point to the user's NAS array.
 * In Kubernetes these should NOT become Longhorn PVCs — they'd waste huge amounts
 * of block storage. Use emptyDir as a placeholder so the pod starts; the operator
 * can overlay a proper NFS/SMB/hostPath mount later.
 *
 * Rule: exact prefix match (or exact match) against the target path.
 */
const MEDIA_SINK_PREFIXES: string[] = [
  "/movies", "/films", "/movie",
  "/tv", "/series", "/shows", "/anime",
  "/music", "/audio",
  "/downloads", "/download", "/completed", "/incomplete", "/torrents",
  "/books", "/ebooks", "/audiobooks", "/comics",
  "/photos", "/pictures", "/images", "/gallery",
  "/media",
  "/watch",          // Sonarr/Radarr watch folders
  "/video",
  "/podcasts",
  "/games",
];

type PathVolumeKind = "pvc" | "hostPath" | "emptyDir" | "skip";
type PathClassification = { kind: PathVolumeKind; medium?: "Memory" };

function classifyPath(target: string): PathClassification {
  const p = target.replace(/\\/g, "/");
  if (RUNTIME_SKIP_PATHS.some(s => p === s || p.startsWith(s + "/"))) return { kind: "skip" };
  for (const ed of EMPTY_DIR_MOUNTS) {
    if (p === ed.prefix || p.startsWith(ed.prefix + "/")) return { kind: "emptyDir", medium: ed.medium };
  }
  if (HOST_PATH_RO.some(h => p === h || p.startsWith(h + "/"))) return { kind: "hostPath" };
  // Media / data-sink paths should be emptyDir, not Longhorn PVCs.
  // These are meant to be NAS mounts in Unraid — creating block-storage PVCs for them
  // wastes cluster storage and causes scheduling issues.
  if (MEDIA_SINK_PREFIXES.some(m => p === m || p.startsWith(m + "/"))) return { kind: "emptyDir" };
  return { kind: "pvc" };
}

/** Whether a target path is a docker socket (for Required-true check). */
function isDockerSocket(target: string): boolean {
  const p = target.replace(/\\/g, "/");
  return p.includes("/var/run/docker.sock") || p.includes("/run/docker.sock");
}

// ── ExtraParams parser ────────────────────────────────────────────────────────

interface ExtraParamsParsed {
  caps: string[];
  sysctls: Array<{ name: string; value: string }>;
  privileged: boolean;
  hostPID: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  /** Memory limit converted to K8s format (e.g. "2Gi"). */
  memoryLimitK8s?: string;
  shmSize?: string;
  envVars: Array<{ name: string; value: string }>;
}

/**
 * Parses Docker ExtraParams (e.g. "--cap-add=NET_ADMIN --sysctl=net.ipv4...=1")
 * into structured data for use in K8s manifest generation.
 */
function parseExtraParams(raw: string): ExtraParamsParsed {
  const result: ExtraParamsParsed = {
    caps: [], sysctls: [], privileged: false, hostPID: false, envVars: [],
  };
  if (!raw?.trim()) return result;

  // Match --flag=value or bare --flag tokens (value may itself contain "=")
  const tokens = raw.match(/--[\w-]+(?:=\S+)?/g) ?? [];
  for (const token of tokens) {
    const eqIdx = token.indexOf("=");
    const flag = eqIdx >= 0 ? token.slice(0, eqIdx) : token;
    const value = eqIdx >= 0 ? token.slice(eqIdx + 1) : "";
    switch (flag) {
      case "--cap-add":
        if (value) result.caps.push(value.toUpperCase());
        break;
      case "--sysctl": {
        const si = value.indexOf("=");
        if (si >= 0) result.sysctls.push({ name: value.slice(0, si), value: value.slice(si + 1) });
        break;
      }
      case "--privileged":
        result.privileged = true;
        break;
      case "--pid":
        if (value === "host") result.hostPID = true;
        break;
      case "--user": {
        const [u, g] = value.split(":");
        const uid = parseInt(u, 10);
        const gid = parseInt(g ?? "", 10);
        if (!isNaN(uid) && uid > 0) result.runAsUser = uid;
        if (!isNaN(gid) && gid > 0) result.runAsGroup = gid;
        break;
      }
      case "--memory":
        if (value) {
          // Docker: "2g"/"2G" → K8s: "2Gi"; "512m"/"512M" → "512Mi"
          result.memoryLimitK8s = value.replace(/([0-9]+)[gG]$/i, "$1Gi").replace(/([0-9]+)[mM]$/i, "$1Mi");
        }
        break;
      case "--shm-size":
        if (value) result.shmSize = value;
        break;
      case "--env":
      case "-e":
        if (value) {
          const ei = value.indexOf("=");
          if (ei >= 0) result.envVars.push({ name: value.slice(0, ei), value: value.slice(ei + 1) });
        }
        break;
    }
  }
  return result;
}

/** True for linuxserver.io images that expect PUID/PGID env vars. */
function isLinuxServerImage(image: string): boolean {
  const img = image.toLowerCase();
  return img.startsWith("lscr.io/linuxserver/") || img.startsWith("linuxserver/");
}

// ── volume info pre-computation ───────────────────────────────────────────────

interface VolumeInfo {
  kind: PathVolumeKind;
  medium?: "Memory";
  volumeName: string;
  mountPath: string;
  originalTarget: string;
  pvcName?: string;
  isReadOnly: boolean;
  /** Human-readable name from the AppFeed config, for PVC comments. */
  configName: string;
  configDefault: string;
  configRequired: boolean;
}

/**
 * Pre-compute all volume information for an app's Path configs.
 * Called once in convertAppFeedEntry and shared across buildVolumeMounts,
 * buildVolumes, and buildPVCs to keep names consistent.
 */
function computeVolumeInfos(configs: AppFeedConfig[], slug: string): VolumeInfo[] {
  let pvcIndex = 0;
  const infos: VolumeInfo[] = [];

  for (const c of configs) {
    if (c["@attributes"]?.Type !== "Path") continue;
    const attrs = c["@attributes"];
    const target = (attrs.Target ?? "").replace(/\\/g, "/");

    // Always skip docker socket paths (required ones were already rejected above)
    if (isDockerSocket(target)) continue;

    const cls = classifyPath(target);
    if (cls.kind === "skip") continue;

    const mountPath = cls.kind === "pvc" ? safeMountDir(target) : target;
    let volumeName: string;
    let pvcName: string | undefined;

    if (cls.kind === "pvc") {
      pvcName = `${slug}-data-${pvcIndex}`;
      volumeName = pvcName;
      pvcIndex++;
    } else if (cls.kind === "hostPath") {
      // e.g. /lib/modules → host-lib-modules
      volumeName = ("host-" + toSlug(target.replace(/^\//, ""))).slice(0, 63);
    } else {
      // emptyDir
      volumeName = ("tmp-" + toSlug(target.replace(/^\//, ""))).slice(0, 63);
    }
    // Ensure valid DNS label start
    volumeName = volumeName.replace(/^[^a-z0-9]/, "v").replace(/-+/g, "-").replace(/-$/, "");

    infos.push({
      kind: cls.kind,
      medium: cls.medium,
      volumeName,
      mountPath,
      originalTarget: target,
      pvcName,
      isReadOnly: cls.kind === "hostPath",
      configName: attrs.Name ?? target,
      configDefault: attrs.Default ?? "",
      configRequired: attrs.Required === "true",
    });
  }
  return infos;
}

export interface AppFeedConfig {
  "@attributes": {
    Name: string;
    Target: string;
    Default: string;
    Mode?: string;
    Description?: string;
    Type: "Variable" | "Port" | "Path" | "Device";
    Display?: string;
    Required?: string;
    Mask?: string;
  };
  value?: string;
}

export interface AppFeedEntry {
  Name: string;
  Repository: string;
  Registry?: string;
  Network?: string;
  Shell?: string;
  Privileged?: string;
  Support?: string;
  Project?: string;
  Overview?: string;
  Icon?: string;
  WebUI?: string;
  ExtraParams?: string;
  PostArgs?: string;
  Requires?: string;
  TemplateURL?: string;
  Config?: AppFeedConfig | AppFeedConfig[];
  CategoryList?: string[];
  downloads?: number;
  stars?: number;
  LastUpdate?: string;
  FirstSeen?: string;
}

export interface ConvertOptions {
  namespace?: string;
  pvcSizeGi?: number;
  storageClass?: string;
  ingressHost?: string;    // override auto-derived host
  createIngress?: boolean;
}

export interface ConversionResult {
  slug: string;
  tier: K8sCompatTier;
  warnings: string[];
  manifests: {
    /** Namespace manifest with pod-security labels (present when hostNetwork/privileged required) */
    namespace?: string;
    deployment: string;
    service?: string;
    pvcs: string[];
    ingressroute?: string;
    /** Secret manifest for masked variables (empty values — operator must fill in) */
    secrets?: string;
  };
  /** Combined YAML ready to write to a single file or split */
  combinedYaml: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return slug || "app";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Port name for K8s Service/containerPorts.
 * Includes a "-u" suffix for UDP to avoid name collisions when an app
 * exposes the same port number on both TCP and UDP (e.g. AdGuard port 53).
 */
function portName(name: string | undefined, port: number, proto?: string): string {
  const udpSuffix = proto?.toLowerCase() === "udp" ? "-u" : "";
  const raw = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 13)   // leave room for "-u" suffix to stay within 15-char limit
    .replace(/-+$/g, "");
  // Fallback "port-{n}" preserves the original naming convention (max port 65535 → "port-65535" = 10 chars + "-u" = 12, well under 15)
  const base = raw || `port-${port}`;
  return (base + udpSuffix).slice(0, 15);
}

function splitArgs(value: string): string[] {
  const matches = value.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map(token => token.replace(/^(["'])(.*)\1$/, "$2"));
}

function extractWebUIPort(webUI: string): number | null {
  const patterns = [
    /\[PORT:(\d{2,5})\]/i,
    /PORT:(\d{2,5})/i,
    /:(\d{2,5})(?:[/?#\]]|$)/,
  ];

  for (const pattern of patterns) {
    const match = webUI.match(pattern);
    if (match) return parseInt(match[1], 10);
  }

  try {
    const normalized = webUI
      .replace(/\[IP\]|\[HOST\]/gi, "127.0.0.1")
      .replace(/\[PORT:(\d{2,5})\]/gi, "$1")
      .replace(/\[PORT\]/gi, "80");
    const url = new URL(normalized.match(/^[a-z]+:\/\//i) ? normalized : `http://${normalized}`);
    const port = parseInt(url.port, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

function getConfigs(app: AppFeedEntry): AppFeedConfig[] {
  if (!app.Config) return [];
  return Array.isArray(app.Config) ? app.Config : [app.Config];
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map(l => (l.trim() ? pad + l : "")).join("\n");
}

function getResourceProfile(appName: string, tier: K8sCompatTier): ResourceProfile {
  return KNOWN_HEAVY_APPS[toSlug(appName)] ?? TIER_RESOURCE_PROFILES[tier];
}

function getProbePort(configs: AppFeedConfig[]): number | null {
  const tcpPort = configs.find((config) => {
    const attrs = config["@attributes"];
    return attrs?.Type === "Port" && String(attrs.Mode ?? "tcp").toLowerCase() !== "udp";
  });

  if (!tcpPort) return null;

  const port = parseInt(tcpPort["@attributes"].Target, 10);
  return Number.isNaN(port) ? null : port;
}

// ── tier detection ───────────────────────────────────────────────────────────

export function detectTier(app: AppFeedEntry): K8sCompatTier {
  const isPrivileged = String(app.Privileged ?? "").toLowerCase() === "true";
  const hasDevice = getConfigs(app).some(c => c["@attributes"]?.Type === "Device");

  // Check ExtraParams for --privileged or --cap-add (needs elevated security context)
  const extra = parseExtraParams(app.ExtraParams ?? "");
  if (isPrivileged || hasDevice || extra.privileged || extra.caps.length > 0) return "complex";

  const network = String(app.Network ?? "").toLowerCase();
  if (network && !["bridge", "host", "none", ""].includes(network)) return "medium";

  return "simple";
}

// ── individual section generators ────────────────────────────────────────────

/**
 * Build env[] lines for a Deployment.
 * @param configs - AppFeed Variable configs
 * @param extraEnvVars - env vars parsed from ExtraParams
 * @param addLinuxServerDefaults - inject PUID/PGID/TZ for linuxserver.io images
 */
function buildEnvVars(
  configs: AppFeedConfig[],
  extraEnvVars: Array<{ name: string; value: string }>,
  addLinuxServerDefaults: boolean
): string[] {
  const lines = configs
    .filter(c => c["@attributes"]?.Type === "Variable")
    .map(c => {
      const attrs = c["@attributes"];
      const value = c.value?.trim() ? c.value : (attrs.Default ?? "");
      const masked = attrs.Mask === "true";
      return [
        `            - name: ${attrs.Target}`,
        masked
          ? `              valueFrom:\n                secretKeyRef:\n                  name: ${toSlug(attrs.Name)}-secret\n                  key: value`
          : `              value: ${yamlString(value)}`,
      ].join("\n");
    });

  // Inject env vars from ExtraParams --env flags (skip if already defined)
  const definedNames = new Set(
    configs.filter(c => c["@attributes"]?.Type === "Variable").map(c => c["@attributes"]?.Target)
  );
  for (const ev of extraEnvVars) {
    if (!definedNames.has(ev.name)) {
      lines.push(`            - name: ${ev.name}\n              value: ${yamlString(ev.value)}`);
      definedNames.add(ev.name);
    }
  }

  // linuxserver.io images use PUID/PGID/TZ for user mapping
  if (addLinuxServerDefaults) {
    if (!definedNames.has("PUID")) lines.push(`            - name: PUID\n              value: "1000"`);
    if (!definedNames.has("PGID")) lines.push(`            - name: PGID\n              value: "1000"`);
    if (!definedNames.has("TZ")) lines.push(`            - name: TZ\n              value: "UTC"`);
  }

  return lines;
}

/** Generate a Kubernetes Secret manifest for all masked variables in the app feed entry.
 * Returns undefined if the app has no masked variables. */
function buildSecretsManifest(configs: AppFeedConfig[], slug: string, namespace: string): string | undefined {
  const masked = configs.filter(c => c["@attributes"]?.Type === "Variable" && c["@attributes"]?.Mask === "true");
  if (masked.length === 0) return undefined;

  const secretDocs = masked.map(c => {
    const attrs = c["@attributes"];
    const secretName = `${toSlug(attrs.Name)}-secret`;
    const defaultVal = c.value?.trim() ? c.value : (attrs.Default ?? "");
    return `---
# Secret for ${attrs.Name} (${attrs.Target})
# Update this value before deploying! This is a placeholder.
apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    infraweaver.io/source: community-apps
type: Opaque
stringData:
  value: ${yamlString(defaultVal || "change-me")}`;
  });

  return secretDocs.join("\n");
}

function buildContainerPorts(configs: AppFeedConfig[]): string[] {
  return configs
    .filter(c => c["@attributes"]?.Type === "Port")
    .map(c => {
      const attrs = c["@attributes"];
      const proto = (attrs.Mode ?? "tcp").toUpperCase();
      const containerPort = parseInt(attrs.Target, 10);
      if (isNaN(containerPort)) return "";
      return [
        `            - containerPort: ${containerPort}`,
        `              protocol: ${proto}`,
        `              name: ${portName(attrs.Name, containerPort, attrs.Mode)}`,
      ].join("\n");
    })
    .filter(Boolean);
}

/**
 * Returns true if the path's last segment looks like a file (has an extension).
 * e.g., "/database.db" → true, "/config" → false, "/data/app.json" → true
 */
function isFileLikePath(p: string): boolean {
  const last = p.split("/").filter(Boolean).pop() ?? "";
  return /\.[a-z0-9]{1,10}$/i.test(last);
}

/**
 * For file-like paths, return a safe parent directory to mount the PVC.
 * Mounting a PVC at a file path creates a directory, causing crashes.
 */
function safeMountDir(p: string): string {
  if (!isFileLikePath(p)) return p;
  const parent = p.substring(0, p.lastIndexOf("/"));
  // If parent is "/" or empty, use "/data" to avoid shadowing the root FS
  return parent && parent !== "/" ? parent : "/data";
}

function buildVolumeMounts(infos: VolumeInfo[]): string[] {
  return infos.map(info => {
    const lines = [
      `            - name: ${info.volumeName}`,
      `              mountPath: ${yamlString(info.mountPath)}`,
    ];
    if (info.isReadOnly) lines.push(`              readOnly: true`);
    return lines.join("\n");
  });
}

function buildVolumes(infos: VolumeInfo[]): string[] {
  return infos.map(info => {
    if (info.kind === "pvc") {
      return [
        `      - name: ${info.volumeName}`,
        `        persistentVolumeClaim:`,
        `          claimName: ${info.pvcName}`,
      ].join("\n");
    } else if (info.kind === "hostPath") {
      return [
        `      - name: ${info.volumeName}`,
        `        hostPath:`,
        `          path: ${info.originalTarget}`,
        `          type: DirectoryOrCreate`,
      ].join("\n");
    } else {
      // emptyDir
      const mediumLine = info.medium ? `\n          medium: ${info.medium}` : "";
      return [
        `      - name: ${info.volumeName}`,
        `        emptyDir:{}${mediumLine}`,
      ].join("\n").replace("emptyDir:{}", "emptyDir:");
    }
  });
}

function buildPVCs(infos: VolumeInfo[], namespace: string, sizeGi: number, storageClass: string): string[] {
  return infos
    .filter(info => info.kind === "pvc")
    .map(info => {
      const adjusted = info.mountPath !== info.originalTarget
        ? ` (adjusted from file path "${info.originalTarget}")` : "";
      return `---
# PVC for "${info.configName}" → ${info.mountPath}${adjusted}
# Default path on Unraid: ${info.configDefault || "(not set)"}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${info.pvcName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${info.volumeName.replace(/-data-\d+$/, "")}
    app.kubernetes.io/component: storage
    infraweaver.io/source: community-apps
  annotations:
    infraweaver.io/unraid-path: ${yamlString(info.configDefault || info.originalTarget)}
    infraweaver.io/required: "${info.configRequired}"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: ${sizeGi}Gi`;
    });
}

/**
 * Builds a Namespace manifest with pod-security labels.
 * Required when an app uses hostNetwork or privileged mode — the cluster's default
 * PodSecurity standard (baseline) forbids these. Setting enforce=privileged on the
 * namespace allows them while audit/warn stay at baseline for visibility.
 */
function buildNamespaceManifest(namespace: string): string {
  return `---
apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
    pod-security.kubernetes.io/enforce: privileged
    pod-security.kubernetes.io/warn: privileged
    pod-security.kubernetes.io/audit: baseline
    infraweaver.io/source: community-apps`;
}

function buildService(ports: AppFeedConfig[], slug: string, namespace: string): string | null {
  const allPorts = ports.filter(c => c["@attributes"]?.Type === "Port");
  if (allPorts.length === 0) return null;

  const portLines = allPorts
    .map(c => {
      const attrs = c["@attributes"];
      const containerPort = parseInt(attrs.Target, 10);
      if (isNaN(containerPort)) return "";
      const proto = (attrs.Mode ?? "tcp").toUpperCase();
      return [
        `  - port: ${containerPort}`,
        `    targetPort: ${containerPort}`,
        `    protocol: ${proto}`,
        `    name: ${portName(attrs.Name, containerPort, attrs.Mode)}`,
      ].join("\n");
    })
    .filter(Boolean);

  if (portLines.length === 0) return null;

  return `---
apiVersion: v1
kind: Service
metadata:
  name: ${slug}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    infraweaver.io/source: community-apps
spec:
  selector:
    app.kubernetes.io/name: ${slug}
  ports:
${portLines.map(p => indent(p, 2)).join("\n")}
  type: ClusterIP`;
}

function buildIngressRoute(slug: string, namespace: string, port: number, host: string): string {
  return `---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: ${slug}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    infraweaver.io/source: community-apps
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(\`${host}\`)
      kind: Rule
      middlewares:
        - name: netbird-vpn-only
          namespace: traefik
      services:
        - name: ${slug}
          port: ${port}
  tls:
    secretName: int-rlservers-com-tls`;
}

// ── main converter ───────────────────────────────────────────────────────────

export function convertAppFeedEntry(
  app: AppFeedEntry,
  options: ConvertOptions = {}
): ConversionResult {
  const appName = app.Name?.trim();
  const image = app.Repository?.trim();

  if (!appName) {
    throw new UserError("AppFeed entry is missing a Name");
  }
  if (!image) {
    throw new UserError(`App "${appName}" is missing a container image`);
  }
  // Reject Unraid plugin/script URLs masquerading as container images
  if (/^https?:\/\//i.test(image)) {
    throw new UserError(`App "${appName}" is an Unraid plugin (not a Docker image) — not deployable on Kubernetes`);
  }

  // Parse ExtraParams early — drives capabilities, user, memory, sysctls
  const extra = parseExtraParams(app.ExtraParams ?? "");

  const configs0 = getConfigs(app);

  // Block only when docker socket is explicitly Required=true.
  // Apps like UptimeKuma list docker.sock as Required=false for optional features —
  // we skip that mount and still deploy the app.
  const hasRequiredDockerSocket = configs0.some(c =>
    c["@attributes"]?.Type === "Path" &&
    isDockerSocket(c["@attributes"]?.Target ?? "") &&
    c["@attributes"]?.Required === "true"
  );
  if (hasRequiredDockerSocket) {
    throw new UserError(`App "${appName}" requires the Docker socket and cannot run in Kubernetes — use a Kubernetes-native monitoring tool instead`);
  }

  const slug = toSlug(appName);
  const namespace = options.namespace?.trim() || slug;
  const pvcSizeGi = options.pvcSizeGi ?? 2;
  // Community apps use the standard HA StorageClass (3 replicas, best-effort locality).
  const storageClass = options.storageClass?.trim() || "longhorn";
  const tier = detectTier(app);

  const warnings: string[] = [];
  const configs = getConfigs(app);

  const isPrivileged = extra.privileged ||
    String(app.Privileged ?? "").toLowerCase() === "true" ||
    configs.some(c => c["@attributes"]?.Type === "Device");
  const isHostNetwork = String(app.Network ?? "").toLowerCase() === "host";
  const hasCustomNetwork = String(app.Network ?? "") !== "" &&
    !["bridge", "host", "none"].includes(String(app.Network ?? "").toLowerCase());

  if (tier === "complex") {
    warnings.push("⚠️ This app requires privileged mode or host device access. Review security context before deploying.");
  }
  if (isHostNetwork) {
    warnings.push("⚠️ This app uses host networking. It will share the node's network namespace.");
  }
  if (hasCustomNetwork) {
    warnings.push(`ℹ️ This app used Docker network "${app.Network}" on Unraid. On K8s all pods share a network — verify service discovery works.`);
  }
  if (app.Requires) {
    warnings.push(`ℹ️ Prerequisites: ${app.Requires}`);
  }
  if (app.PostArgs?.trim()) {
    warnings.push(`ℹ️ Unraid PostArgs ("${app.PostArgs}") are set as the container args.`);
  }

  // Warn about optional docker.sock paths that are being silently skipped
  const hasOptionalDockerSocket = configs.some(c =>
    c["@attributes"]?.Type === "Path" &&
    isDockerSocket(c["@attributes"]?.Target ?? "") &&
    c["@attributes"]?.Required !== "true"
  );
  if (hasOptionalDockerSocket) {
    warnings.push("ℹ️ Docker socket mount skipped (optional feature on Unraid; not available in Kubernetes). Docker-dependent features will be unavailable.");
  }

  // Pre-compute volume infos (shared by mounts, volumes, pvcs)
  const volumeInfos = computeVolumeInfos(configs, slug);

  // Warn for skipped/adjusted paths
  configs.filter(c => c["@attributes"]?.Type === "Path").forEach(c => {
    const target = (c["@attributes"]?.Target ?? "").replace(/\\/g, "/");
    if (isDockerSocket(target)) return; // already warned above
    const cls = classifyPath(target);
    if (cls.kind === "skip") return;
    if (cls.kind === "hostPath") {
      warnings.push(`ℹ️ Mount path "${target}" is a host OS path — mounted as read-only hostPath (not a PVC).`);
    } else if (cls.kind === "pvc" && isFileLikePath(target)) {
      const adjusted = safeMountDir(target);
      warnings.push(`ℹ️ Mount path "${target}" is a file — PVC mounted at parent directory "${adjusted}" instead.`);
    }
  });

  const secretsYaml = buildSecretsManifest(configs, slug, namespace);
  if (secretsYaml) {
    warnings.push("🔑 This app has masked/secret variables. A secrets.yaml was created with placeholder values — update them before deploying.");
  }

  // Extract image + args
  const postArgs = splitArgs(app.PostArgs ?? "");
  const argsYaml = postArgs.length > 0
    ? `\n          args:\n${postArgs.map(arg => `            - ${yamlString(arg)}`).join("\n")}`
    : "";

  // Build env vars (with linuxserver.io PUID/PGID injection and ExtraParams envs)
  const envVars = buildEnvVars(configs, extra.envVars, isLinuxServerImage(image));
  const containerPorts = buildContainerPorts(configs);
  const volumeMounts = buildVolumeMounts(volumeInfos);
  const volumes = buildVolumes(volumeInfos);
  const pvcs = buildPVCs(volumeInfos, namespace, pvcSizeGi, storageClass);

  // ── Container security context ──────────────────────────────────────────────
  const secCtxLines: string[] = [];
  if (isPrivileged) {
    secCtxLines.push("privileged: true");
  } else if (extra.caps.length > 0) {
    // Add capabilities from ExtraParams (e.g. NET_ADMIN, SYS_MODULE for WireGuard)
    secCtxLines.push("capabilities:");
    secCtxLines.push("  add:");
    for (const cap of extra.caps) secCtxLines.push(`    - ${cap}`);
  }
  // Note: we deliberately do NOT set allowPrivilegeEscalation: false — many community
  // apps use setuid binaries or spawn privileged child processes and would crash silently.

  // ── Pod-level security context ──────────────────────────────────────────────
  const fsGroup = extra.runAsGroup ?? 1000;
  const podSecCtxParts: string[] = [`fsGroup: ${fsGroup}`];
  if (extra.runAsUser !== undefined) podSecCtxParts.push(`runAsUser: ${extra.runAsUser}`);
  if (extra.runAsGroup !== undefined) podSecCtxParts.push(`runAsGroup: ${extra.runAsGroup}`);
  if (extra.sysctls.length > 0) {
    podSecCtxParts.push("sysctls:");
    for (const s of extra.sysctls) {
      podSecCtxParts.push(`  - name: ${s.name}`);
      podSecCtxParts.push(`    value: ${yamlString(s.value)}`);
    }
  }
  const podSecCtxYaml = indent(podSecCtxParts.join("\n"), 8);

  // ── Resources — respect ExtraParams --memory ────────────────────────────────
  const baseResources = getResourceProfile(appName, tier);
  const memLimit = extra.memoryLimitK8s ?? baseResources.memLimit;
  // Ensure memReq ≤ memLimit
  const resources = { ...baseResources, memLimit };

  // ── Health probes with startupProbe to handle slow first-start ──────────────
  // startupProbe gives the container up to (failureThreshold × periodSeconds) seconds
  // to start before liveness/readiness probes begin, preventing CrashLoopBackOff.
  const probePort = getProbePort(configs);
  const hasPvcs = pvcs.length > 0;
  // Stateful apps (PVCs) can take longer: 10 min; stateless: 5 min
  const startupFailureThreshold = hasPvcs ? 120 : 60;
  const probeYaml = probePort !== null
    ? [
      "          startupProbe:",
      "            tcpSocket:",
      `              port: ${probePort}`,
      "            initialDelaySeconds: 5",
      "            periodSeconds: 5",
      `            failureThreshold: ${startupFailureThreshold}`,
      "          readinessProbe:",
      "            tcpSocket:",
      `              port: ${probePort}`,
      "            periodSeconds: 10",
      "            failureThreshold: 3",
      "          livenessProbe:",
      "            tcpSocket:",
      `              port: ${probePort}`,
      "            periodSeconds: 30",
      "            failureThreshold: 3",
    ].join("\n")
    : "";

  // ── shm-size → emptyDir volume at /dev/shm ──────────────────────────────────
  const shmVolumeMount = extra.shmSize
    ? `            - name: dshm\n              mountPath: "/dev/shm"` : "";
  const shmVolume = extra.shmSize
    ? `      - name: dshm\n        emptyDir:\n          medium: Memory\n          sizeLimit: ${extra.shmSize}` : "";

  const allVolumeMounts = [...volumeMounts, ...(shmVolumeMount ? [shmVolumeMount] : [])];
  const allVolumes = [...volumes, ...(shmVolume ? [shmVolume] : [])];

  const hostPidLine = extra.hostPID ? "\n      hostPID: true" : "";
  const containerSecCtxYaml = secCtxLines.length > 0
    ? `          securityContext:\n${indent(secCtxLines.join("\n"), 12)}\n`
    : "";

  const deploymentYaml = `---
# Generated by InfraWeaver Community Apps from Unraid AppFeed
# Source: ${app.TemplateURL ?? ""}
# Category: ${(app.CategoryList ?? []).join(", ")}
# Stars: ${app.stars ?? 0} | Downloads: ${app.downloads ?? 0}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${slug}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    app.kubernetes.io/managed-by: infraweaver
    infraweaver.io/source: community-apps
    infraweaver.io/tier: ${tier}
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ${slug}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${slug}
    spec:${isHostNetwork ? "\n      hostNetwork: true" : ""}${hostPidLine}
      securityContext:
${podSecCtxYaml}
      containers:
        - name: ${slug}
          image: ${image}${argsYaml}
${envVars.length > 0 ? `          env:\n${envVars.join("\n")}` : "          # No environment variables defined"}
${containerPorts.length > 0 ? `          ports:\n${containerPorts.join("\n")}` : "          # No ports defined"}
${probeYaml}
${allVolumeMounts.length > 0 ? `          volumeMounts:\n${allVolumeMounts.join("\n")}` : "          # No volume mounts defined"}
${containerSecCtxYaml}          resources:
            requests:
              memory: ${yamlString(resources.memReq)}
              cpu: ${yamlString(resources.cpuReq)}
            limits:
              memory: ${yamlString(memLimit)}
              cpu: ${yamlString(resources.cpuLimit)}
${allVolumes.length > 0 ? `      volumes:\n${allVolumes.join("\n")}` : "      # No volumes defined"}`;

  const portConfigs = configs.filter(c => c["@attributes"]?.Type === "Port");
  let serviceYaml = buildService(portConfigs, slug, namespace);

  // ── IngressRoute port resolution ─────────────────────────────────────────
  // Priority:
  // 1. WebUI URL port matched back to container Target (fixes Default≠Target confusion)
  // 2. First TCP portConfig Target port
  // 3. WebUI URL port directly (apps with WebUI but zero Port-type configs)
  const createIngress = options.createIngress ?? (!!app.WebUI || portConfigs.length > 0);
  let ingressRouteYaml: string | undefined;

  if (createIngress) {
    let ingressPort: number | null = null;

    if (app.WebUI && portConfigs.length > 0) {
      const webUIDefaultPort = extractWebUIPort(app.WebUI);
      if (webUIDefaultPort) {
        // Try to resolve WebUI port (which is often the HOST/default port) back to the
        // CONTAINER port (Target).  Look for a portConfig whose Default == webUIDefaultPort.
        const matched = portConfigs.find(
          c => parseInt(c["@attributes"].Default ?? "", 10) === webUIDefaultPort
        );
        if (matched) {
          const targetPort = parseInt(matched["@attributes"].Target, 10);
          if (!isNaN(targetPort)) ingressPort = targetPort;
        }
        // If no Default-match, try a direct Target match (host port == container port)
        if (!ingressPort) {
          const direct = portConfigs.find(
            c => parseInt(c["@attributes"].Target, 10) === webUIDefaultPort
          );
          if (direct) ingressPort = webUIDefaultPort;
        }
      }
    }

    // Fallback: first TCP portConfig Target
    if (!ingressPort && portConfigs.length > 0) {
      const firstTcp = portConfigs.find(
        c => (c["@attributes"]?.Mode ?? "tcp").toLowerCase() !== "udp"
      );
      if (firstTcp) {
        const t = parseInt(firstTcp["@attributes"].Target, 10);
        if (!isNaN(t)) ingressPort = t;
      }
    }

    // Fallback: WebUI URL port directly (app has WebUI but no Port-type configs)
    if (!ingressPort && app.WebUI) {
      ingressPort = extractWebUIPort(app.WebUI);
    }

    if (ingressPort && !isNaN(ingressPort)) {
      // If no Service was generated (no Port configs), create a minimal fallback Service
      // using the ingressPort so the IngressRoute has something to route to.
      if (!serviceYaml) {
        serviceYaml = `---
apiVersion: v1
kind: Service
metadata:
  name: ${slug}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    infraweaver.io/source: community-apps
spec:
  selector:
    app.kubernetes.io/name: ${slug}
  ports:
  - port: ${ingressPort}
    targetPort: ${ingressPort}
    protocol: TCP
    name: http
  type: ClusterIP`;
      }
      const host = options.ingressHost ?? `${slug}.int.rlservers.com`;
      ingressRouteYaml = buildIngressRoute(slug, namespace, ingressPort, host);
    }
  }

  // Namespace manifest — required when hostNetwork or privileged to override PodSecurity baseline
  const needsPrivilegedNamespace = isPrivileged || isHostNetwork;
  const namespaceYaml = needsPrivilegedNamespace ? buildNamespaceManifest(namespace) : undefined;

  const allParts: string[] = [];
  if (namespaceYaml) allParts.push(namespaceYaml);
  allParts.push(deploymentYaml);
  if (serviceYaml) allParts.push(serviceYaml);
  allParts.push(...pvcs);
  if (ingressRouteYaml) allParts.push(ingressRouteYaml);
  if (secretsYaml) allParts.push(secretsYaml);

  return {
    slug,
    tier,
    warnings,
    manifests: {
      namespace: namespaceYaml,
      deployment: deploymentYaml,
      service: serviceYaml ?? undefined,
      pvcs,
      ingressroute: ingressRouteYaml,
      secrets: secretsYaml ?? undefined,
    },
    combinedYaml: allParts.join("\n") + "\n",
  };
}

// ── feed schema (minimal) for API layer ──────────────────────────────────────

export interface AppFeedSummary {
  name: string;
  slug: string;
  image: string;
  icon?: string;
  overview?: string;
  categories: string[];
  tier: K8sCompatTier;
  stars?: number;
  downloads?: number;
  webUI?: string;
  support?: string;
  lastUpdate?: string;
  configCount: number;
  /** True when the app cannot be deployed on Kubernetes (e.g. requires Docker socket or is an Unraid plugin). */
  incompatible?: true;
  /** Human-readable reason when incompatible is true. */
  incompatibleReason?: string;
}

export function summarizeApp(app: AppFeedEntry): AppFeedSummary {
  const configs = getConfigs(app);
  const isPlugin = /^https?:\/\//i.test(app.Repository ?? "");

  // Only mark incompatible when docker.sock is Required=true.
  // Apps with optional docker.sock (like UptimeKuma) still work without it.
  const hasRequiredDockerSocket = configs.some(c =>
    c["@attributes"]?.Type === "Path" &&
    isDockerSocket(c["@attributes"]?.Target ?? "") &&
    c["@attributes"]?.Required === "true"
  );

  const summary: AppFeedSummary = {
    name: app.Name,
    slug: toSlug(app.Name),
    image: app.Repository,
    icon: app.Icon,
    overview: app.Overview?.slice(0, 500),
    categories: app.CategoryList ?? [],
    tier: detectTier(app),
    stars: app.stars,
    downloads: app.downloads,
    webUI: app.WebUI,
    support: app.Support,
    lastUpdate: app.LastUpdate,
    configCount: configs.length,
  };

  if (hasRequiredDockerSocket) {
    summary.incompatible = true;
    summary.incompatibleReason = "Requires Docker socket — not supported on Kubernetes";
  } else if (isPlugin) {
    summary.incompatible = true;
    summary.incompatibleReason = "Unraid plugin (not a container image) — not deployable on Kubernetes";
  }

  return summary;
}
