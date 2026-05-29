import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import * as yaml from "js-yaml";
import { ACCESS_TIER_MIDDLEWARES, detectAccessTier, normalizeMiddlewareName, type AccessTier } from "@/lib/access-tier";
import type { ExternalRouteItem, ExternalRouteMutationInput, ExternalRoutesResponse, ExternalRouteTargetType } from "@/lib/external-routes";

const TRAEFIK_NAMESPACE = "traefik";
const MANIFEST_DIR = path.join("kubernetes", "platform", "external-routes", "manifests");
const CLUSTER_BACKENDS_FILE = "04-backends-cluster.yaml";
const BAREMETAL_BACKENDS_FILE = "05-backends-baremetal.yaml";
const ROUTE_FILES: Record<AccessTier, string> = {
  internal: "07-routes-internal.yaml",
  public: "08-routes-external.yaml",
  vpn: "10-routes-vpn-only.yaml",
};

type ManifestResource = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string | undefined>;
  };
  spec?: {
    entryPoints?: string[];
    routes?: Array<{
      match?: string;
      kind?: string;
      middlewares?: Array<{ name?: string; namespace?: string }>;
      services?: Array<{
        name?: string;
        namespace?: string;
        port?: number | string;
        scheme?: string;
        serversTransport?: string;
      }>;
    }>;
    tls?: { secretName?: string; certResolver?: string };
    type?: string;
    externalName?: string;
    ports?: Array<{ port?: number; targetPort?: number | string; name?: string }>;
  };
  subsets?: Array<{
    addresses?: Array<{ ip?: string }>;
    ports?: Array<{ port?: number; name?: string }>;
  }>;
};

type ParsedBlock = {
  raw: string;
  data: ManifestResource | null;
  kind: string | null;
  name: string | null;
  namespace: string | null;
  file: string;
  key: string | null;
};

type ManifestFile = {
  file: string;
  absPath: string;
  originalContent: string;
  blocks: ParsedBlock[];
};

type BackendIndex = {
  clusterServices: Map<string, ParsedBlock>;
  baremetalServices: Map<string, ParsedBlock>;
  baremetalEndpoints: Map<string, ParsedBlock>;
};

type RouteBlockLocation = {
  manifest: ManifestFile;
  block: ParsedBlock;
};

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function resourceKey(kind: string | null | undefined, namespace: string | null | undefined, name: string | null | undefined) {
  if (!kind || !name) return null;
  return `${kind}:${namespace ?? TRAEFIK_NAMESPACE}/${name}`;
}

function splitYamlDocuments(raw: string) {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [] as string[];
  return normalized.split(/^---\s*$/m).map((part) => part.trim()).filter(Boolean);
}

function parseManifestDocument(raw: string, file: string): ParsedBlock {
  const data = (yaml.load(raw) as ManifestResource | null) ?? null;
  const kind = data?.kind ?? null;
  const name = data?.metadata?.name ?? null;
  const namespace = data?.metadata?.namespace ?? TRAEFIK_NAMESPACE;
  return {
    raw: raw.trim(),
    data,
    kind,
    name,
    namespace,
    file,
    key: resourceKey(kind, namespace, name),
  };
}

async function loadManifest(repoDir: string, file: string): Promise<ManifestFile> {
  const absPath = path.join(repoDir, MANIFEST_DIR, file);
  let originalContent = "";
  try {
    originalContent = await fs.readFile(absPath, "utf8");
  } catch {
    originalContent = "";
  }
  const blocks = splitYamlDocuments(originalContent).map((block) => parseManifestDocument(block, file));
  return { file, absPath, originalContent, blocks };
}

function stringifyDocument(data: ManifestResource) {
  return yaml.dump(data, { lineWidth: -1, indent: 2, noRefs: true }).trim();
}

function manifestContent(blocks: ParsedBlock[]) {
  if (blocks.length === 0) return "";
  return `${blocks.map((block) => `---\n${block.raw.trim()}`).join("\n")}`.trimEnd() + "\n";
}

async function saveManifest(manifest: ManifestFile) {
  const nextContent = manifestContent(manifest.blocks);
  if (nextContent === manifest.originalContent) return false;
  await fs.writeFile(manifest.absPath, nextContent, "utf8");
  manifest.originalContent = nextContent;
  return true;
}

function routeHosts(match: string | undefined) {
  if (!match) return [] as string[];
  const values = new Set<string>();
  for (const pattern of [/Host\(`([^`]+)`\)/g, /HostSNI\(`([^`]+)`\)/g]) {
    for (const entry of match.matchAll(pattern)) {
      if (entry[1]) values.add(entry[1]);
    }
  }
  return Array.from(values);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)).map((value) => value.trim()).filter(Boolean)));
}

function parsePort(value: number | string | undefined, fallback = 80) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}

function parseExternalName(externalName: string | undefined) {
  const match = externalName?.match(/^([^.]+)\.([^.]+)\.svc\.cluster\.local$/);
  if (!match) return null;
  return { service: match[1], namespace: match[2] };
}

function buildBackendIndex(clusterBackends: ManifestFile, baremetalBackends: ManifestFile): BackendIndex {
  const clusterServices = new Map<string, ParsedBlock>();
  const baremetalServices = new Map<string, ParsedBlock>();
  const baremetalEndpoints = new Map<string, ParsedBlock>();

  for (const block of clusterBackends.blocks) {
    if (block.kind === "Service" && block.name && block.namespace) {
      clusterServices.set(resourceKey("Service", block.namespace, block.name)!, block);
    }
  }

  for (const block of baremetalBackends.blocks) {
    if (!block.name || !block.namespace) continue;
    if (block.kind === "Service") baremetalServices.set(resourceKey("Service", block.namespace, block.name)!, block);
    if (block.kind === "Endpoints") baremetalEndpoints.set(resourceKey("Endpoints", block.namespace, block.name)!, block);
  }

  return { clusterServices, baremetalServices, baremetalEndpoints };
}

function serviceKey(namespace: string, name: string) {
  return resourceKey("Service", namespace, name)!;
}

function endpointsKey(namespace: string, name: string) {
  return resourceKey("Endpoints", namespace, name)!;
}

function routeServiceRefs(route: ManifestResource) {
  const defaultNamespace = route.metadata?.namespace ?? TRAEFIK_NAMESPACE;
  return asArray(route.spec?.routes).flatMap((entry) => asArray(entry.services).map((service) => ({
    name: service.name ?? "service",
    namespace: service.namespace ?? defaultNamespace,
    port: parsePort(service.port),
    scheme: service.scheme === "https" ? "https" as const : "http" as const,
    skipTlsVerify: service.serversTransport === "insecure-skip-verify",
  })));
}

function countRoutesUsingBackend(routeManifests: ManifestFile[], backendServiceName: string, excludingRouteName?: string) {
  return asArray(routeManifests).flatMap((manifest) => asArray(manifest.blocks))
    .filter((block) => block.kind === "IngressRoute" && block.data)
    .filter((block) => block.name !== excludingRouteName)
    .some((block) => routeServiceRefs(block.data!).some((service) => service.name === backendServiceName && service.namespace === TRAEFIK_NAMESPACE));
}

function preferredSecurityMiddleware(accessTier: AccessTier, netbirdEnabled: boolean) {
  if (accessTier === "vpn") return netbirdEnabled ? ACCESS_TIER_MIDDLEWARES.vpn : ACCESS_TIER_MIDDLEWARES.internal;
  if (accessTier === "internal") return ACCESS_TIER_MIDDLEWARES.internal;
  return null;
}

function buildRouteMiddlewares(accessTier: AccessTier, enableAuth: boolean, netbirdEnabled: boolean) {
  const security = preferredSecurityMiddleware(accessTier, netbirdEnabled);
  const names = uniqueStrings(["secure-headers", security, enableAuth ? "forward-auth" : null]);
  return names.map((name) => ({ name, namespace: TRAEFIK_NAMESPACE }));
}

function buildRouteDocument(input: ExternalRouteMutationInput, backendServiceName: string, netbirdEnabled: boolean): ManifestResource {
  const scheme = input.scheme === "https" ? "https" : "http";
  const skipTlsVerify = Boolean(input.skipTlsVerify && scheme === "https");
  const routeService = {
    name: backendServiceName,
    namespace: TRAEFIK_NAMESPACE,
    port: input.targetPort,
    ...(scheme === "https" ? { scheme } : {}),
    ...(skipTlsVerify ? { serversTransport: "insecure-skip-verify" } : {}),
  };

  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: {
      name: input.name,
      namespace: TRAEFIK_NAMESPACE,
      labels: {
        "infraweaver.io/access-tier": input.accessTier,
      },
    },
    spec: {
      entryPoints: ["websecure"],
      routes: [{
        match: `Host(\`${input.host}\`)`,
        kind: "Rule",
        middlewares: buildRouteMiddlewares(input.accessTier, Boolean(input.enableAuth), netbirdEnabled),
        services: [routeService],
      }],
      ...(input.tlsSecret ? { tls: { secretName: input.tlsSecret } } : {}),
    },
  };
}

function buildClusterBackendDocument(backendServiceName: string, input: ExternalRouteMutationInput): ManifestResource {
  const targetService = input.targetService?.trim() || input.name;
  const targetNamespace = input.targetNamespace?.trim() || TRAEFIK_NAMESPACE;
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: backendServiceName,
      namespace: TRAEFIK_NAMESPACE,
      labels: {
        "infraweaver.io/managed-route": input.name,
      },
    },
    spec: {
      type: "ExternalName",
      externalName: `${targetService}.${targetNamespace}.svc.cluster.local`,
      ports: [{
        port: input.targetPort,
        name: input.scheme === "https" ? "https" : "http",
      }],
    },
  };
}

function buildBaremetalServiceDocument(backendServiceName: string, input: ExternalRouteMutationInput): ManifestResource {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: backendServiceName,
      namespace: TRAEFIK_NAMESPACE,
      labels: {
        "infraweaver.io/managed-route": input.name,
      },
    },
    spec: {
      ports: [{ port: input.targetPort }],
    },
  };
}

function buildBaremetalEndpointsDocument(backendServiceName: string, input: ExternalRouteMutationInput): ManifestResource {
  return {
    apiVersion: "v1",
    kind: "Endpoints",
    metadata: {
      name: backendServiceName,
      namespace: TRAEFIK_NAMESPACE,
      labels: {
        "infraweaver.io/managed-route": input.name,
      },
    },
    subsets: [{
      addresses: [{ ip: input.targetIP?.trim() || "127.0.0.1" }],
      ports: [{ port: input.targetPort }],
    }],
  };
}

function replaceBlock(manifest: ManifestFile, kind: string, namespace: string, name: string, data: ManifestResource) {
  const key = resourceKey(kind, namespace, name);
  const nextBlock = parseManifestDocument(stringifyDocument(data), manifest.file);
  const index = manifest.blocks.findIndex((block) => block.key === key);
  if (index === -1) {
    manifest.blocks.push(nextBlock);
    return;
  }
  manifest.blocks[index] = nextBlock;
}

function removeBlock(manifest: ManifestFile, kind: string, namespace: string, name: string) {
  const key = resourceKey(kind, namespace, name);
  manifest.blocks = manifest.blocks.filter((block) => block.key !== key);
}

async function isNetbirdEnabled(repoDir: string) {
  try {
    const platformPath = path.join(repoDir, "platform.yaml");
    const raw = await fs.readFile(platformPath, "utf8");
    const parsed = (yaml.load(raw) as { groups?: Record<string, { enabled?: boolean; apps?: Record<string, { enabled?: boolean }> }> }) ?? {};
    const groups = parsed.groups ?? {};
    const corePlatformEnabled = groups["core-platform"]?.enabled !== false;
    return corePlatformEnabled && groups["core-platform"]?.apps?.netbird?.enabled !== false;
  } catch {
    return true;
  }
}

function parseRouteItem(routeBlock: ParsedBlock, index: BackendIndex): ExternalRouteItem | null {
  if (!routeBlock.data || routeBlock.kind !== "IngressRoute" || !routeBlock.name || !routeBlock.namespace) return null;
  const route = routeBlock.data;
  const middlewares = uniqueStrings(asArray(route.spec?.routes).flatMap((entry) =>
    asArray(entry.middlewares).map((middleware) => `${middleware.namespace ?? route.metadata?.namespace ?? TRAEFIK_NAMESPACE}/${middleware.name ?? "middleware"}`),
  ));
  const serviceRefs = routeServiceRefs(route);
  const firstService = serviceRefs[0];
  const hosts = uniqueStrings(asArray(route.spec?.routes).flatMap((entry) => routeHosts(entry.match)));
  const accessTier = detectAccessTier(route.metadata?.labels?.["infraweaver.io/access-tier"], middlewares);
  const normalizedMiddlewares = middlewares.map((middleware) => normalizeMiddlewareName(middleware));
  const securityMiddleware = normalizedMiddlewares.find((middleware) => middleware === ACCESS_TIER_MIDDLEWARES.vpn || middleware === ACCESS_TIER_MIDDLEWARES.internal) ?? null;
  const backendServiceName = firstService?.name ?? route.metadata?.name ?? routeBlock.name;
  const backendNamespace = firstService?.namespace ?? route.metadata?.namespace ?? TRAEFIK_NAMESPACE;
  const baremetalService = index.baremetalServices.get(serviceKey(backendNamespace, backendServiceName));
  const baremetalEndpoints = index.baremetalEndpoints.get(endpointsKey(backendNamespace, backendServiceName));
  const clusterWrapper = index.clusterServices.get(serviceKey(backendNamespace, backendServiceName));
  const parsedExternalName = parseExternalName(clusterWrapper?.data?.spec?.externalName);
  const targetType: ExternalRouteTargetType = baremetalService ? "baremetal" : "k8s";
  const targetIP = baremetalEndpoints?.data?.subsets?.[0]?.addresses?.[0]?.ip ?? null;
  const targetPort = firstService?.port
    ?? parsePort(baremetalService?.data?.spec?.ports?.[0]?.port)
    ?? parsePort(clusterWrapper?.data?.spec?.ports?.[0]?.port);
  const targetService = baremetalService
    ? backendServiceName
    : parsedExternalName?.service ?? firstService?.name ?? route.metadata?.name ?? routeBlock.name;
  const targetNamespace = baremetalService
    ? TRAEFIK_NAMESPACE
    : parsedExternalName?.namespace ?? firstService?.namespace ?? TRAEFIK_NAMESPACE;
  const scheme = firstService?.scheme === "https" ? "https" : "http";
  const skipTlsVerify = Boolean(firstService?.skipTlsVerify);

  return {
    id: `${route.metadata?.namespace ?? TRAEFIK_NAMESPACE}/${route.metadata?.name ?? routeBlock.name}`,
    name: route.metadata?.name ?? routeBlock.name,
    namespace: route.metadata?.namespace ?? TRAEFIK_NAMESPACE,
    hosts,
    middlewares,
    accessTier,
    services: uniqueStrings(asArray(serviceRefs).map((service) => `${service.namespace}/${service.name}:${service.port}`)),
    tlsSecretName: route.spec?.tls?.secretName ?? null,
    certResolver: route.spec?.tls?.certResolver ?? null,
    hasTls: Boolean(route.spec?.tls?.secretName || route.spec?.tls?.certResolver),
    entryPoints: asArray(route.spec?.entryPoints),
    enableAuth: normalizedMiddlewares.includes("forward-auth") || normalizedMiddlewares.includes("forward-auth-admin"),
    file: routeBlock.file,
    targetType,
    targetService,
    targetNamespace,
    targetPort,
    targetIP,
    scheme,
    skipTlsVerify,
    backendServiceName,
    hasNetbirdFallback: accessTier === "vpn" && securityMiddleware !== ACCESS_TIER_MIDDLEWARES.vpn,
  };
}

async function loadState(repoDir: string) {
  const routeManifests = await Promise.all(Object.values(ROUTE_FILES).map((file) => loadManifest(repoDir, file)));
  const clusterBackends = await loadManifest(repoDir, CLUSTER_BACKENDS_FILE);
  const baremetalBackends = await loadManifest(repoDir, BAREMETAL_BACKENDS_FILE);
  const backendIndex = buildBackendIndex(clusterBackends, baremetalBackends);
  return { routeManifests, clusterBackends, baremetalBackends, backendIndex, netbirdEnabled: await isNetbirdEnabled(repoDir) };
}

function findRouteLocation(routeManifests: ManifestFile[], name: string): RouteBlockLocation | null {
  for (const manifest of routeManifests) {
    const block = manifest.blocks.find((entry) => entry.kind === "IngressRoute" && entry.name === name);
    if (block) return { manifest, block };
  }
  return null;
}

async function persistAndCommit(repoDir: string, manifests: ManifestFile[], message: string) {
  const changed = [] as string[];
  for (const manifest of manifests) {
    if (await saveManifest(manifest)) changed.push(manifest.file);
  }
  if (changed.length === 0) return changed;
  execFileSync("git", ["-C", repoDir, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit",
    "-m", `feat(routes): ${message}`,
    "-m", "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>",
  ], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "push"], { stdio: "pipe" });
  return changed;
}

export async function loadExternalRoutes(repoDir = process.env.REPO_DIR || process.env.IW_REPO_DIR || "/opt/infraweaver"): Promise<ExternalRoutesResponse> {
  const state = await loadState(repoDir);
  const routes = asArray(state.routeManifests)
    .flatMap((manifest) => asArray(manifest.blocks))
    .map((block) => parseRouteItem(block, state.backendIndex))
    .filter((route): route is ExternalRouteItem => Boolean(route))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    routes,
    files: Object.values(ROUTE_FILES).map((file) => path.join(MANIFEST_DIR, file)),
  };
}

export async function createExternalRoute(input: ExternalRouteMutationInput, repoDir = process.env.REPO_DIR || process.env.IW_REPO_DIR || "/opt/infraweaver") {
  const state = await loadState(repoDir);
  if (findRouteLocation(state.routeManifests, input.name)) {
    throw new Error(`Route ${input.name} already exists`);
  }

  const targetManifest = state.routeManifests.find((manifest) => manifest.file === ROUTE_FILES[input.accessTier]);
  if (!targetManifest) throw new Error(`Unable to resolve manifest for ${input.accessTier}`);

  const backendServiceName = input.targetType === "baremetal" ? `bm-${input.name}` : `ext-${input.name}`;
  const routeDocument = buildRouteDocument(input, backendServiceName, state.netbirdEnabled);
  targetManifest.blocks.push(parseManifestDocument(stringifyDocument(routeDocument), targetManifest.file));

  if (input.targetType === "baremetal") {
    replaceBlock(state.baremetalBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName, buildBaremetalServiceDocument(backendServiceName, input));
    replaceBlock(state.baremetalBackends, "Endpoints", TRAEFIK_NAMESPACE, backendServiceName, buildBaremetalEndpointsDocument(backendServiceName, input));
  } else {
    replaceBlock(state.clusterBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName, buildClusterBackendDocument(backendServiceName, input));
  }

  await persistAndCommit(repoDir, [...state.routeManifests, state.clusterBackends, state.baremetalBackends], `add ${input.name} external route`);
  return loadExternalRoutes(repoDir);
}

export async function updateExternalRoute(name: string, input: ExternalRouteMutationInput, repoDir = process.env.REPO_DIR || process.env.IW_REPO_DIR || "/opt/infraweaver") {
  const state = await loadState(repoDir);
  const location = findRouteLocation(state.routeManifests, name);
  if (!location) throw new Error(`Route ${name} not found`);

  const current = parseRouteItem(location.block, state.backendIndex);
  if (!current) throw new Error(`Route ${name} could not be parsed`);

  if (current.backendServiceName && countRoutesUsingBackend(state.routeManifests, current.backendServiceName, name)) {
    const backendChanged = current.targetType !== input.targetType
      || current.targetService !== (input.targetService?.trim() || current.targetService)
      || current.targetNamespace !== (input.targetNamespace?.trim() || current.targetNamespace)
      || current.targetPort !== input.targetPort
      || (current.targetIP ?? "") !== (input.targetIP?.trim() ?? current.targetIP ?? "");
    if (backendChanged) {
      throw new Error(`Route ${name} shares backend ${current.backendServiceName} with another route; update the backend separately`);
    }
  }

  const backendServiceName = current.backendServiceName || (input.targetType === "baremetal" ? `bm-${name}` : `ext-${name}`);
  const routeDocument = buildRouteDocument({ ...input, name }, backendServiceName, state.netbirdEnabled);
  const destinationManifest = state.routeManifests.find((manifest) => manifest.file === ROUTE_FILES[input.accessTier]);
  if (!destinationManifest) throw new Error(`Unable to resolve manifest for ${input.accessTier}`);

  location.manifest.blocks = location.manifest.blocks.filter((block) => block !== location.block);
  destinationManifest.blocks.push(parseManifestDocument(stringifyDocument(routeDocument), destinationManifest.file));

  if (input.targetType === "baremetal") {
    replaceBlock(state.baremetalBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName, buildBaremetalServiceDocument(backendServiceName, { ...input, name }));
    replaceBlock(state.baremetalBackends, "Endpoints", TRAEFIK_NAMESPACE, backendServiceName, buildBaremetalEndpointsDocument(backendServiceName, { ...input, name }));
    removeBlock(state.clusterBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName);
  } else {
    replaceBlock(state.clusterBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName, buildClusterBackendDocument(backendServiceName, { ...input, name }));
    removeBlock(state.baremetalBackends, "Service", TRAEFIK_NAMESPACE, backendServiceName);
    removeBlock(state.baremetalBackends, "Endpoints", TRAEFIK_NAMESPACE, backendServiceName);
  }

  await persistAndCommit(repoDir, [...state.routeManifests, state.clusterBackends, state.baremetalBackends], `update ${name} external route`);
  return loadExternalRoutes(repoDir);
}

export async function deleteExternalRoute(name: string, repoDir = process.env.REPO_DIR || process.env.IW_REPO_DIR || "/opt/infraweaver") {
  const state = await loadState(repoDir);
  const location = findRouteLocation(state.routeManifests, name);
  if (!location) throw new Error(`Route ${name} not found`);

  const current = parseRouteItem(location.block, state.backendIndex);
  location.manifest.blocks = location.manifest.blocks.filter((block) => block !== location.block);

  if (current && !countRoutesUsingBackend(state.routeManifests, current.backendServiceName, name)) {
    removeBlock(state.clusterBackends, "Service", TRAEFIK_NAMESPACE, current.backendServiceName);
    removeBlock(state.baremetalBackends, "Service", TRAEFIK_NAMESPACE, current.backendServiceName);
    removeBlock(state.baremetalBackends, "Endpoints", TRAEFIK_NAMESPACE, current.backendServiceName);
  }

  await persistAndCommit(repoDir, [...state.routeManifests, state.clusterBackends, state.baremetalBackends], `remove ${name} external route`);
  return loadExternalRoutes(repoDir);
}
