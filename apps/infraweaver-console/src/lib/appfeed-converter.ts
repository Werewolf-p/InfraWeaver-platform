/**
 * appfeed-converter.ts
 *
 * Converts Unraid Community Applications AppFeed entries into Kubernetes manifests.
 *
 * Unraid → K8s mapping:
 *   Config Type "Variable" → env[] in Deployment
 *   Config Type "Port"     → containerPorts[] + ClusterIP Service
 *   Config Type "Path"     → volumeMounts[] + PersistentVolumeClaim
 *   Config Type "Device"   → securityContext.privileged (flagged as complex)
 *   Network: host          → hostNetwork: true
 *   Privileged: true       → securityContext.privileged: true
 *   WebUI field            → port extracted for Traefik IngressRoute
 */

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
};

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

function portName(name: string | undefined, port: number): string {
  const candidate = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 15)
    .replace(/-+$/g, "");
  return candidate || `port-${port}`;
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

  if (isPrivileged || hasDevice) return "complex";

  const network = String(app.Network ?? "").toLowerCase();
  if (network && !["bridge", "host", "none", ""].includes(network)) return "medium";

  return "simple";
}

// ── individual section generators ────────────────────────────────────────────

function buildEnvVars(configs: AppFeedConfig[]): string[] {
  return configs
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
        `              name: ${portName(attrs.Name, containerPort)}`,
      ].join("\n");
    })
    .filter(Boolean);
}

function buildVolumeMounts(configs: AppFeedConfig[], slug: string): string[] {
  return configs
    .filter(c => c["@attributes"]?.Type === "Path")
    .map((c, i) => {
      const attrs = c["@attributes"];
      const mountPath = attrs.Target;
      const pvcName = `${slug}-data-${i}`;
      return [
        `            - name: ${pvcName}`,
        `              mountPath: ${yamlString(mountPath)}`,
      ].join("\n");
    });
}

function buildVolumes(configs: AppFeedConfig[], slug: string): string[] {
  return configs
    .filter(c => c["@attributes"]?.Type === "Path")
    .map((c, i) => {
      const pvcName = `${slug}-data-${i}`;
      return [
        `      - name: ${pvcName}`,
        `        persistentVolumeClaim:`,
        `          claimName: ${pvcName}`,
      ].join("\n");
    });
}

function buildPVCs(configs: AppFeedConfig[], slug: string, namespace: string, sizeGi: number, storageClass: string): string[] {
  return configs
    .filter(c => c["@attributes"]?.Type === "Path")
    .map((c, i) => {
      const attrs = c["@attributes"];
      const pvcName = `${slug}-data-${i}`;
      const required = attrs.Required === "true";
      return `---
# PVC for "${attrs.Name}" → ${attrs.Target}
# Default path on Unraid: ${attrs.Default || "(not set)"}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${pvcName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ${slug}
    app.kubernetes.io/component: storage
    infraweaver.io/source: community-apps
  annotations:
    infraweaver.io/unraid-path: ${yamlString(attrs.Default || attrs.Target)}
    infraweaver.io/required: "${required}"
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: ${storageClass}
  resources:
    requests:
      storage: ${sizeGi}Gi`;
    });
}

function buildService(ports: AppFeedConfig[], slug: string, namespace: string): string | null {
  const tcpPorts = ports.filter(c => c["@attributes"]?.Type === "Port");
  if (tcpPorts.length === 0) return null;

  const portLines = tcpPorts
    .map(c => {
      const attrs = c["@attributes"];
      const containerPort = parseInt(attrs.Target, 10);
      if (isNaN(containerPort)) return "";
      const proto = (attrs.Mode ?? "tcp").toUpperCase();
      return [
        `  - port: ${containerPort}`,
        `    targetPort: ${containerPort}`,
        `    protocol: ${proto}`,
        `    name: ${portName(attrs.Name, containerPort)}`,
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
    throw new Error("AppFeed entry is missing a Name");
  }
  if (!image) {
    throw new Error(`App "${appName}" is missing a container image`);
  }

  const slug = toSlug(appName);
  const namespace = options.namespace?.trim() || slug;
  const pvcSizeGi = options.pvcSizeGi ?? 10;
  // Community apps use the standard HA StorageClass (3 replicas, best-effort locality).
  // longhorn-game is reserved for game servers only (strict-local, single replica).
  const storageClass = options.storageClass?.trim() || "longhorn";
  const tier = detectTier(app);

  const warnings: string[] = [];
  const configs = getConfigs(app);

  const isPrivileged = String(app.Privileged ?? "").toLowerCase() === "true" ||
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

  // Build env vars
  const envVars = buildEnvVars(configs);
  const containerPorts = buildContainerPorts(configs);
  const volumeMounts = buildVolumeMounts(configs, slug);
  const volumes = buildVolumes(configs, slug);
  const pvcs = buildPVCs(configs, slug, namespace, pvcSizeGi, storageClass);
  const secretsYaml = buildSecretsManifest(configs, slug, namespace);

  // Warn if masked variables need manual secret updates
  if (secretsYaml) {
    warnings.push("🔑 This app has masked/secret variables. A secrets.yaml was created with placeholder values — update them before deploying.");
  }

  // Extract image + args
  const postArgs = splitArgs(app.PostArgs ?? "");
  const argsYaml = postArgs.length > 0
    ? `\n          args:\n${postArgs.map(arg => `            - ${yamlString(arg)}`).join("\n")}`
    : "";

  // Security context
  const secCtxLines: string[] = [];
  if (isPrivileged) secCtxLines.push("privileged: true");
  if (!isPrivileged) {
    secCtxLines.push("runAsNonRoot: false");
    secCtxLines.push("allowPrivilegeEscalation: false");
  }

  const resources = getResourceProfile(appName, tier);
  const probePort = getProbePort(configs);
  const tcpProbeYaml = probePort !== null
    ? [
      "          readinessProbe:",
      "            tcpSocket:",
      `              port: ${probePort}`,
      "            initialDelaySeconds: 30",
      "            failureThreshold: 10",
      "          livenessProbe:",
      "            tcpSocket:",
      `              port: ${probePort}`,
      "            initialDelaySeconds: 30",
      "            failureThreshold: 10",
    ].join("\n")
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
    spec:${isHostNetwork ? "\n      hostNetwork: true" : ""}
      securityContext:
        fsGroup: 1000
      containers:
        - name: ${slug}
          image: ${image}${argsYaml}
${envVars.length > 0 ? `          env:\n${envVars.join("\n")}` : "          # No environment variables defined"}
${containerPorts.length > 0 ? `          ports:\n${containerPorts.join("\n")}` : "          # No ports defined"}
${tcpProbeYaml}
${volumeMounts.length > 0 ? `          volumeMounts:\n${volumeMounts.join("\n")}` : "          # No volume mounts defined"}
          securityContext:
${indent(secCtxLines.join("\n"), 12)}
          resources:
            requests:
              memory: ${yamlString(resources.memReq)}
              cpu: ${yamlString(resources.cpuReq)}
            limits:
              memory: ${yamlString(resources.memLimit)}
              cpu: ${yamlString(resources.cpuLimit)}
${volumes.length > 0 ? `      volumes:\n${volumes.join("\n")}` : "      # No volumes defined"}`;

  const portConfigs = configs.filter(c => c["@attributes"]?.Type === "Port");
  const serviceYaml = buildService(portConfigs, slug, namespace);

  // IngressRoute: use WebUI hint or first TCP port
  let ingressRouteYaml: string | undefined;
  const createIngress = options.createIngress ?? (!!app.WebUI || portConfigs.length > 0);

  if (createIngress) {
    let port: number | null = null;
    if (app.WebUI) port = extractWebUIPort(app.WebUI);
    if (!port && portConfigs.length > 0) {
      port = parseInt(portConfigs[0]["@attributes"].Target, 10);
    }

    if (port && !isNaN(port)) {
      const host = options.ingressHost ?? `${slug}.int.rlservers.com`;
      ingressRouteYaml = buildIngressRoute(slug, namespace, port, host);
    }
  }

  const allParts: string[] = [deploymentYaml];
  if (serviceYaml) allParts.push(serviceYaml);
  allParts.push(...pvcs);
  if (ingressRouteYaml) allParts.push(ingressRouteYaml);
  if (secretsYaml) allParts.push(secretsYaml);

  return {
    slug,
    tier,
    warnings,
    manifests: {
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
}

export function summarizeApp(app: AppFeedEntry): AppFeedSummary {
  return {
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
    configCount: getConfigs(app).length,
  };
}
