import * as k8s from '@kubernetes/client-node';
import type { ClusterMeta } from '../types/index.js';

const REGISTRY_NAMESPACE = 'infraweaver-system';
const REGISTRY_CONFIGMAP = 'infraweaver-cluster-registry';
const REGISTRY_DATA_KEY = 'clusters';
const CREDS_SECRET_PREFIX = 'infraweaver-cluster-creds-';
const ARGOCD_SECRET_PREFIX = 'infraweaver-cluster-argocd-';

let _coreApi: k8s.CoreV1Api | null = null;

function getRegistryCoreApi(): k8s.CoreV1Api {
  if (_coreApi) {
    return _coreApi;
  }

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }

  _coreApi = kc.makeApiClient(k8s.CoreV1Api);
  return _coreApi;
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as {
    statusCode?: unknown;
    response?: { statusCode?: unknown };
    body?: { code?: unknown };
  };

  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode;
  }
  if (typeof candidate.response?.statusCode === 'number') {
    return candidate.response.statusCode;
  }
  if (typeof candidate.body?.code === 'number') {
    return candidate.body.code;
  }

  return undefined;
}

function isNotFound(error: unknown): boolean {
  return getStatusCode(error) === 404;
}

function encodeSecretValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function decodeSecretValue(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return Buffer.from(value, 'base64').toString('utf8');
}

function sanitizeClusterMeta(meta: ClusterMeta): ClusterMeta {
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    endpoint: meta.endpoint,
    tags: [...meta.tags],
    status: meta.status,
    lastSeen: meta.lastSeen,
    isLocal: meta.isLocal,
    argocdServer: meta.argocdServer,
  };
}

async function ensureNamespace(coreApi: k8s.CoreV1Api): Promise<void> {
  try {
    await coreApi.readNamespace({ name: REGISTRY_NAMESPACE });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }

    await coreApi.createNamespace({
      body: {
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: REGISTRY_NAMESPACE },
      },
    });
  }
}

async function ensureRegistryConfigMap(coreApi: k8s.CoreV1Api) {
  await ensureNamespace(coreApi);

  try {
    return await coreApi.readNamespacedConfigMap({
      name: REGISTRY_CONFIGMAP,
      namespace: REGISTRY_NAMESPACE,
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }

    await coreApi.createNamespacedConfigMap({
      namespace: REGISTRY_NAMESPACE,
      body: {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: { name: REGISTRY_CONFIGMAP, namespace: REGISTRY_NAMESPACE },
        data: { [REGISTRY_DATA_KEY]: '[]' },
      },
    });

    return coreApi.readNamespacedConfigMap({
      name: REGISTRY_CONFIGMAP,
      namespace: REGISTRY_NAMESPACE,
    });
  }
}

async function readStoredClusters(): Promise<ClusterMeta[]> {
  const coreApi = getRegistryCoreApi();
  const configMap = await ensureRegistryConfigMap(coreApi) as { data?: Record<string, string> };
  const raw = configMap.data?.[REGISTRY_DATA_KEY] ?? '[]';

  try {
    const parsed = JSON.parse(raw) as ClusterMeta[];
    return Array.isArray(parsed) ? parsed.map(sanitizeClusterMeta) : [];
  } catch {
    return [];
  }
}

async function writeStoredClusters(clusters: ClusterMeta[]): Promise<void> {
  const coreApi = getRegistryCoreApi();
  const configMap = await ensureRegistryConfigMap(coreApi) as { metadata?: { resourceVersion?: string } };

  await coreApi.replaceNamespacedConfigMap({
    name: REGISTRY_CONFIGMAP,
    namespace: REGISTRY_NAMESPACE,
    body: {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: REGISTRY_CONFIGMAP,
        namespace: REGISTRY_NAMESPACE,
        resourceVersion: configMap.metadata?.resourceVersion,
      },
      data: {
        [REGISTRY_DATA_KEY]: JSON.stringify(clusters.map(sanitizeClusterMeta)),
      },
    },
  });
}

async function readSecret(secretName: string): Promise<Record<string, string> | null> {
  const coreApi = getRegistryCoreApi();

  try {
    const secret = await coreApi.readNamespacedSecret({
      name: secretName,
      namespace: REGISTRY_NAMESPACE,
    }) as { data?: Record<string, string> };

    return secret.data ?? {};
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function upsertSecret(secretName: string, data: Record<string, string>): Promise<void> {
  const coreApi = getRegistryCoreApi();
  await ensureNamespace(coreApi);

  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: secretName, namespace: REGISTRY_NAMESPACE },
    type: 'Opaque',
    data,
  };

  try {
    const existing = await coreApi.readNamespacedSecret({
      name: secretName,
      namespace: REGISTRY_NAMESPACE,
    }) as { metadata?: { resourceVersion?: string } };

    await coreApi.replaceNamespacedSecret({
      name: secretName,
      namespace: REGISTRY_NAMESPACE,
      body: {
        ...body,
        metadata: {
          ...body.metadata,
          resourceVersion: existing.metadata?.resourceVersion,
        },
      },
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }

    await coreApi.createNamespacedSecret({
      namespace: REGISTRY_NAMESPACE,
      body,
    });
  }
}

async function deleteSecret(secretName: string): Promise<void> {
  const coreApi = getRegistryCoreApi();

  try {
    await coreApi.deleteNamespacedSecret({
      name: secretName,
      namespace: REGISTRY_NAMESPACE,
    });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
}

async function getClusterArgocdToken(clusterId: string): Promise<string | undefined> {
  const secret = await readSecret(`${ARGOCD_SECRET_PREFIX}${clusterId}`);
  return decodeSecretValue(secret?.token);
}

export async function listClusters(): Promise<ClusterMeta[]> {
  return readStoredClusters();
}

export async function getCluster(id: string): Promise<ClusterMeta | null> {
  const cluster = (await readStoredClusters()).find((item) => item.id === id);
  if (!cluster) {
    return null;
  }

  if (!cluster.isLocal) {
    const argocdToken = await getClusterArgocdToken(id);
    if (argocdToken) {
      return { ...cluster, argocdToken };
    }
  }

  return cluster;
}

export async function getClusterKubeconfig(clusterId: string): Promise<string> {
  const secret = await readSecret(`${CREDS_SECRET_PREFIX}${clusterId}`);
  const kubeconfig = decodeSecretValue(secret?.kubeconfig);
  if (!kubeconfig) {
    throw new Error('Cluster credentials not found');
  }
  return kubeconfig;
}

export async function addCluster(meta: ClusterMeta, kubeconfig: string): Promise<void> {
  const clusters = await readStoredClusters();
  if (clusters.some((cluster) => cluster.id === meta.id)) {
    throw new Error('Cluster already exists');
  }

  const next = [...clusters, sanitizeClusterMeta(meta)];
  await writeStoredClusters(next);

  if (!meta.isLocal) {
    await upsertSecret(`${CREDS_SECRET_PREFIX}${meta.id}`, {
      kubeconfig: encodeSecretValue(kubeconfig),
      endpoint: encodeSecretValue(meta.endpoint),
    });
  }

  if (meta.argocdToken) {
    await upsertSecret(`${ARGOCD_SECRET_PREFIX}${meta.id}`, {
      token: encodeSecretValue(meta.argocdToken),
    });
  }
}

export async function removeCluster(id: string): Promise<void> {
  const clusters = await readStoredClusters();
  await writeStoredClusters(clusters.filter((cluster) => cluster.id !== id));
  await deleteSecret(`${CREDS_SECRET_PREFIX}${id}`);
  await deleteSecret(`${ARGOCD_SECRET_PREFIX}${id}`);
}

export async function updateClusterStatus(id: string, status: ClusterMeta['status']): Promise<void> {
  const clusters = await readStoredClusters();
  const next = clusters.map((cluster) => {
    if (cluster.id !== id) {
      return cluster;
    }

    return {
      ...cluster,
      status,
      lastSeen: new Date().toISOString(),
    };
  });

  await writeStoredClusters(next);
}

export async function initLocalCluster(): Promise<void> {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }

  const now = new Date().toISOString();
  const localCluster: ClusterMeta = {
    id: 'local',
    name: 'Local Cluster',
    description: 'Cluster hosting infraweaver-api',
    endpoint: 'https://kubernetes.default.svc',
    tags: ['local'],
    status: 'healthy',
    lastSeen: now,
    isLocal: true,
  };

  const clusters = await readStoredClusters();
  const filtered = clusters.filter((cluster) => cluster.id !== 'local');
  filtered.unshift(localCluster);
  await writeStoredClusters(filtered);
}
