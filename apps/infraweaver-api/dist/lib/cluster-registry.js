import * as k8s from '@kubernetes/client-node';
const REGISTRY_NAMESPACE = 'infraweaver-system';
const REGISTRY_CONFIGMAP = 'infraweaver-cluster-registry';
const REGISTRY_DATA_KEY = 'clusters';
const CREDS_SECRET_PREFIX = 'infraweaver-cluster-creds-';
const ARGOCD_SECRET_PREFIX = 'infraweaver-cluster-argocd-';
let _coreApi = null;
function getRegistryCoreApi() {
    if (_coreApi) {
        return _coreApi;
    }
    const kc = new k8s.KubeConfig();
    try {
        kc.loadFromCluster();
    }
    catch {
        kc.loadFromDefault();
    }
    _coreApi = kc.makeApiClient(k8s.CoreV1Api);
    return _coreApi;
}
function getStatusCode(error) {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }
    const candidate = error;
    for (const value of [candidate.statusCode, candidate.response?.statusCode, candidate.status, candidate.response?.status, candidate.body?.code, candidate.code]) {
        if (typeof value === 'number') {
            return value;
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            return Number.parseInt(value, 10);
        }
    }
    if (typeof candidate.message === 'string') {
        const match = candidate.message.match(/\b(4\d\d|5\d\d)\b/);
        if (match) {
            return Number.parseInt(match[1], 10);
        }
    }
    return undefined;
}
function isNotFound(error) {
    if (getStatusCode(error) === 404) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /\b404\b|not\s*found/i.test(message);
}
function encodeSecretValue(value) {
    return Buffer.from(value, 'utf8').toString('base64');
}
function decodeSecretValue(value) {
    if (!value) {
        return undefined;
    }
    return Buffer.from(value, 'base64').toString('utf8');
}
function sanitizeClusterMeta(meta) {
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
async function ensureNamespace(coreApi) {
    try {
        await coreApi.readNamespace({ name: REGISTRY_NAMESPACE });
    }
    catch (error) {
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
async function ensureRegistryConfigMap(coreApi) {
    await ensureNamespace(coreApi);
    try {
        return await coreApi.readNamespacedConfigMap({
            name: REGISTRY_CONFIGMAP,
            namespace: REGISTRY_NAMESPACE,
        });
    }
    catch (error) {
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
async function readStoredClusters() {
    const coreApi = getRegistryCoreApi();
    const configMap = await ensureRegistryConfigMap(coreApi);
    const raw = configMap.data?.[REGISTRY_DATA_KEY] ?? '[]';
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map(sanitizeClusterMeta) : [];
    }
    catch {
        return [];
    }
}
async function writeStoredClusters(clusters) {
    const coreApi = getRegistryCoreApi();
    const configMap = await ensureRegistryConfigMap(coreApi);
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
async function readSecret(secretName) {
    const coreApi = getRegistryCoreApi();
    try {
        const secret = await coreApi.readNamespacedSecret({
            name: secretName,
            namespace: REGISTRY_NAMESPACE,
        });
        return secret.data ?? {};
    }
    catch (error) {
        if (isNotFound(error)) {
            return null;
        }
        throw error;
    }
}
async function upsertSecret(secretName, data) {
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
        });
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
    }
    catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
        await coreApi.createNamespacedSecret({
            namespace: REGISTRY_NAMESPACE,
            body,
        });
    }
}
async function deleteSecret(secretName) {
    const coreApi = getRegistryCoreApi();
    try {
        await coreApi.deleteNamespacedSecret({
            name: secretName,
            namespace: REGISTRY_NAMESPACE,
        });
    }
    catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
    }
}
async function getClusterArgocdToken(clusterId) {
    const secret = await readSecret(`${ARGOCD_SECRET_PREFIX}${clusterId}`);
    return decodeSecretValue(secret?.token);
}
export async function listClusters() {
    return readStoredClusters();
}
export async function getCluster(id) {
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
export async function getClusterKubeconfig(clusterId) {
    const secret = await readSecret(`${CREDS_SECRET_PREFIX}${clusterId}`);
    const kubeconfig = decodeSecretValue(secret?.kubeconfig);
    if (!kubeconfig) {
        throw new Error('Cluster credentials not found');
    }
    return kubeconfig;
}
export async function addCluster(meta, kubeconfig) {
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
export async function removeCluster(id) {
    const clusters = await readStoredClusters();
    await writeStoredClusters(clusters.filter((cluster) => cluster.id !== id));
    await deleteSecret(`${CREDS_SECRET_PREFIX}${id}`);
    await deleteSecret(`${ARGOCD_SECRET_PREFIX}${id}`);
}
export async function updateClusterStatus(id, status) {
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
export async function initLocalCluster() {
    const kc = new k8s.KubeConfig();
    try {
        kc.loadFromCluster();
    }
    catch {
        kc.loadFromDefault();
    }
    const now = new Date().toISOString();
    const localCluster = {
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
//# sourceMappingURL=cluster-registry.js.map