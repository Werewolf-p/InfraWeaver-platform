import type * as k8s from "@kubernetes/client-node";
import yaml from "js-yaml";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import type { GameHubClients } from "@/lib/game-hub-server";

const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_GITHUB_REPO = "Werewolf-p/InfraWeaver-platform";
const GIT_SERVERS_PATH = "kubernetes/catalog/game-hub/servers";
const TRANSIENT_ANNOTATION_KEYS = new Set([
  "deployment.kubernetes.io/revision",
  "infraweaver.io/last-started",
  "infraweaver.io/last-stopped",
  "infraweaver/maintenance",
  "infraweaver/notes",
  "infraweaver/player-history",
  "kubectl.kubernetes.io/last-applied-configuration",
  "kubectl.kubernetes.io/restartedAt",
]);

interface GitHubFileContent {
  sha: string;
}

interface MetadataLike {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

function getGitHubConfig() {
  const apiUrl = (process.env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, "");
  const repo = process.env.GITHUB_REPO ?? DEFAULT_GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN ?? "";
  return {
    apiUrl,
    repo,
    token,
    repoApi: `${apiUrl}/repos/${repo}`,
  };
}

function manifestPath(name: string) {
  return `${GIT_SERVERS_PATH}/${name}.yaml`;
}

function githubHeaders(token: string, includeJson = false): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (includeJson) headers["Content-Type"] = "application/json";
  return headers;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function cleanAnnotations(annotations?: Record<string, string>) {
  if (!annotations) return undefined;
  const filtered = Object.fromEntries(
    Object.entries(annotations).filter(([key, value]) => Boolean(value) && !TRANSIENT_ANNOTATION_KEYS.has(key))
  );
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function sanitizeMetadata(metadata?: MetadataLike, includeNamespace = true) {
  if (!metadata) return undefined;
  const sanitized = compactObject({
    name: metadata.name,
    namespace: includeNamespace ? metadata.namespace : undefined,
    labels: metadata.labels && Object.keys(metadata.labels).length > 0 ? cloneJson(metadata.labels) : undefined,
    annotations: cleanAnnotations(metadata.annotations),
  });
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeNamespace(name: string) {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name,
    },
  };
}

function sanitizePersistentVolumeClaim(pvc: k8s.V1PersistentVolumeClaim) {
  const spec = cloneJson(pvc.spec ?? {});
  delete (spec as { volumeName?: string }).volumeName;
  return compactObject({
    apiVersion: pvc.apiVersion ?? "v1",
    kind: pvc.kind ?? "PersistentVolumeClaim",
    metadata: sanitizeMetadata(pvc.metadata),
    spec,
  });
}

function sanitizeDeployment(deployment: k8s.V1Deployment) {
  const spec = cloneJson(deployment.spec ?? {}) as k8s.V1DeploymentSpec;
  if (spec.template) {
    spec.template.metadata = sanitizeMetadata(spec.template.metadata as MetadataLike | undefined, false);
  }
  return compactObject({
    apiVersion: deployment.apiVersion ?? "apps/v1",
    kind: deployment.kind ?? "Deployment",
    metadata: sanitizeMetadata(deployment.metadata),
    spec,
  });
}

function sanitizeService(service: k8s.V1Service) {
  const spec = cloneJson(service.spec ?? {});
  delete (spec as { clusterIP?: string }).clusterIP;
  delete (spec as { clusterIPs?: string[] }).clusterIPs;
  delete (spec as { healthCheckNodePort?: number }).healthCheckNodePort;
  delete (spec as { ipFamilies?: string[] }).ipFamilies;
  delete (spec as { ipFamilyPolicy?: string }).ipFamilyPolicy;
  return compactObject({
    apiVersion: service.apiVersion ?? "v1",
    kind: service.kind ?? "Service",
    metadata: sanitizeMetadata(service.metadata),
    spec,
  });
}

function sanitizeConfigMap(configMap: k8s.V1ConfigMap) {
  return compactObject({
    apiVersion: configMap.apiVersion ?? "v1",
    kind: configMap.kind ?? "ConfigMap",
    metadata: sanitizeMetadata(configMap.metadata),
    data: cloneJson(configMap.data ?? {}),
    binaryData: configMap.binaryData ? cloneJson(configMap.binaryData) : undefined,
  });
}

function sanitizeHorizontalPodAutoscaler(hpa: k8s.V2HorizontalPodAutoscaler) {
  return compactObject({
    apiVersion: hpa.apiVersion ?? "autoscaling/v2",
    kind: hpa.kind ?? "HorizontalPodAutoscaler",
    metadata: sanitizeMetadata(hpa.metadata),
    spec: cloneJson(hpa.spec ?? {}),
  });
}

function sanitizeCronJob(cronJob: k8s.V1CronJob) {
  return compactObject({
    apiVersion: cronJob.apiVersion ?? "batch/v1",
    kind: cronJob.kind ?? "CronJob",
    metadata: sanitizeMetadata(cronJob.metadata),
    spec: cloneJson(cronJob.spec ?? {}),
  });
}

async function readOptional<T>(reader: Promise<T>): Promise<T | null> {
  try {
    return await reader;
  } catch {
    return null;
  }
}

function serializeDocuments(documents: Array<Record<string, unknown>>) {
  return `${documents
    .map((document) => `---\n${yaml.dump(document, { lineWidth: -1, noRefs: true }).trimEnd()}`)
    .join("\n")}\n`;
}

export async function generateServerManifestYaml(name: string, clients: GameHubClients): Promise<string> {
  const deployment = await clients.appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
  const [service, eggConfigMap, hpa, restartCronJob, backupCronJob] = await Promise.all([
    clients.coreApi.readNamespacedService({ name, namespace: GAME_HUB_NAMESPACE }),
    readOptional(clients.coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE })),
    readOptional(clients.autoscalingApi.readNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE })),
    readOptional(clients.batchApi.readNamespacedCronJob({ name: `gameserver-${name}-restart`, namespace: GAME_HUB_NAMESPACE })),
    readOptional(clients.batchApi.readNamespacedCronJob({ name: `gameserver-${name}-backup`, namespace: GAME_HUB_NAMESPACE })),
  ]);

  const pvcName = deployment.spec?.template?.spec?.volumes
    ?.find((volume) => volume.persistentVolumeClaim?.claimName)
    ?.persistentVolumeClaim?.claimName;
  const pvc = pvcName
    ? await readOptional(clients.coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: GAME_HUB_NAMESPACE }))
    : null;

  const documents: Array<Record<string, unknown>> = [sanitizeNamespace(GAME_HUB_NAMESPACE)];
  if (pvc) documents.push(sanitizePersistentVolumeClaim(pvc));
  if (eggConfigMap) documents.push(sanitizeConfigMap(eggConfigMap));
  documents.push(sanitizeDeployment(deployment));
  documents.push(sanitizeService(service));
  if (hpa) documents.push(sanitizeHorizontalPodAutoscaler(hpa));
  if (restartCronJob) documents.push(sanitizeCronJob(restartCronJob));
  if (backupCronJob) documents.push(sanitizeCronJob(backupCronJob));

  return serializeDocuments(documents);
}

export async function readServerManifestSha(name: string): Promise<string | null> {
  const { repoApi, token } = getGitHubConfig();
  const path = manifestPath(name);
  const response = await fetch(`${repoApi}/contents/${path}`, {
    headers: githubHeaders(token),
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub GET ${path}: ${response.status}`);
  const data = (await response.json()) as GitHubFileContent;
  return data.sha ?? null;
}

export async function writeServerManifest(name: string, clients: GameHubClients): Promise<void> {
  const { repoApi, token } = getGitHubConfig();
  if (!token) {
    console.warn(`writeServerManifest skipped for ${name}: GITHUB_TOKEN is not set`);
    return;
  }

  const [yamlContent, sha] = await Promise.all([
    generateServerManifestYaml(name, clients),
    readServerManifestSha(name),
  ]);
  const path = manifestPath(name);
  const response = await fetch(`${repoApi}/contents/${path}`, {
    method: "PUT",
    headers: githubHeaders(token, true),
    body: JSON.stringify({
      message: `chore(game-hub): update server manifest for ${name}`,
      content: Buffer.from(yamlContent, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub PUT ${path}: ${response.status} — ${await response.text()}`);
  }
}

export async function deleteServerManifest(name: string): Promise<void> {
  const { repoApi, token } = getGitHubConfig();
  if (!token) return;

  const sha = await readServerManifestSha(name);
  if (!sha) return;

  const path = manifestPath(name);
  const response = await fetch(`${repoApi}/contents/${path}`, {
    method: "DELETE",
    headers: githubHeaders(token, true),
    body: JSON.stringify({
      message: `chore(game-hub): delete server manifest for ${name}`,
      sha,
    }),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`GitHub DELETE ${path}: ${response.status} — ${await response.text()}`);
  }
}
