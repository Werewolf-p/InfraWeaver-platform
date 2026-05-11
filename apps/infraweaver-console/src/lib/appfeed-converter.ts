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
  };
  /** Combined YAML ready to write to a single file or split */
  combinedYaml: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
}

function extractWebUIPort(webUI: string): number | null {
  // Patterns: :PORT/path, [IP]:[PORT], http://[IP]:[PORT]
  const match = webUI.match(/:(\d{2,5})/);
  return match ? parseInt(match[1], 10) : null;
}

function getConfigs(app: AppFeedEntry): AppFeedConfig[] {
  if (!app.Config) return [];
  return Array.isArray(app.Config) ? app.Config : [app.Config];
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map(l => (l.trim() ? pad + l : "")).join("\n");
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
      const value = (c.value ?? attrs.Default ?? "").replace(/"/g, '\\"');
      const masked = attrs.Mask === "true";
      return [
        `        - name: ${attrs.Target}`,
        masked
          ? `          valueFrom:\n            secretKeyRef:\n              name: ${toSlug(attrs.Name)}-secret\n              key: value`
          : `          value: "${value}"`,
      ].join("\n");
    });
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
        `        - containerPort: ${containerPort}`,
        `          protocol: ${proto}`,
        `          name: ${toSlug(attrs.Name).slice(0, 15)}`,
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
        `        - name: ${pvcName}`,
        `          mountPath: "${mountPath}"`,
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
    infraweaver.io/unraid-path: "${attrs.Default || attrs.Target}"
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
        `    name: ${toSlug(attrs.Name).slice(0, 15)}`,
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
  const slug = toSlug(app.Name);
  const namespace = options.namespace ?? slug;
  const pvcSizeGi = options.pvcSizeGi ?? 10;
  const storageClass = options.storageClass ?? "longhorn";
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
  if (app.PostArgs) {
    warnings.push(`ℹ️ Unraid PostArgs ("${app.PostArgs}") are set as the container command args.`);
  }

  // Build env vars
  const envVars = buildEnvVars(configs);
  const containerPorts = buildContainerPorts(configs);
  const volumeMounts = buildVolumeMounts(configs, slug);
  const volumes = buildVolumes(configs, slug);
  const pvcs = buildPVCs(configs, slug, namespace, pvcSizeGi, storageClass);

  // Extract image + tag
  const image = app.Repository;
  const postArgs = app.PostArgs ? `\n      command:\n${app.PostArgs.split(" ").map(a => `        - "${a}"`).join("\n")}` : "";

  // Security context
  const secCtxLines: string[] = [];
  if (isPrivileged) secCtxLines.push("        privileged: true");
  if (!isPrivileged) {
    secCtxLines.push("        runAsNonRoot: false");
    secCtxLines.push("        allowPrivilegeEscalation: false");
  }

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
  selector:
    matchLabels:
      app.kubernetes.io/name: ${slug}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${slug}
    spec:${isHostNetwork ? "\n      hostNetwork: true" : ""}
      containers:
        - name: ${slug}
          image: ${image}${postArgs}
${envVars.length > 0 ? `          env:\n${envVars.join("\n")}` : "          # No environment variables defined"}
${containerPorts.length > 0 ? `          ports:\n${containerPorts.join("\n")}` : "          # No ports defined"}
${volumeMounts.length > 0 ? `          volumeMounts:\n${volumeMounts.join("\n")}` : "          # No volume mounts defined"}
          securityContext:
${secCtxLines.join("\n")}
          resources:
            requests:
              memory: "128Mi"
              cpu: "50m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
${volumes.length > 0 ? `      volumes:\n${volumes.join("\n")}` : "      # No volumes defined"}`;

  const portConfigs = configs.filter(c => c["@attributes"]?.Type === "Port");
  const serviceYaml = buildService(portConfigs, slug, namespace);

  // IngressRoute: use WebUI hint or first TCP port
  let ingressRouteYaml: string | undefined;
  let createIngress = options.createIngress ?? (!!app.WebUI || portConfigs.length > 0);

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

  const kustomizationYaml = `---
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${namespace}
resources:
  - deployment.yaml
${serviceYaml ? "  - service.yaml\n" : ""}${pvcs.length > 0 ? "  - pvc.yaml\n" : ""}${ingressRouteYaml ? "  - ingressroute.yaml\n" : ""}`;

  const allParts: string[] = [deploymentYaml];
  if (serviceYaml) allParts.push(serviceYaml);
  allParts.push(...pvcs);
  if (ingressRouteYaml) allParts.push(ingressRouteYaml);

  return {
    slug,
    tier,
    warnings,
    manifests: {
      deployment: deploymentYaml,
      service: serviceYaml ?? undefined,
      pvcs,
      ingressroute: ingressRouteYaml,
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
