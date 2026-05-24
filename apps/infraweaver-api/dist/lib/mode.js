import * as k8s from '@kubernetes/client-node';
let _cachedMode = 'live';
let _cacheExpiry = 0;
let _coreApi = null;
const CACHE_TTL_MS = 5_000;
const MODE_NAMESPACE = process.env.MODE_NAMESPACE ?? 'infraweaver-console';
const MODE_CM_NAME = 'infraweaver-api-mode';
let _broadcastFn = null;
function getCoreApi() {
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
function isNotFound(error) {
    return getStatusCode(error) === 404;
}
export async function getMode() {
    if (Date.now() < _cacheExpiry) {
        return _cachedMode;
    }
    try {
        const coreApi = getCoreApi();
        const configMap = await coreApi.readNamespacedConfigMap({
            name: MODE_CM_NAME,
            namespace: MODE_NAMESPACE,
        });
        const mode = configMap.data?.mode;
        _cachedMode = mode === 'deployment' ? 'deployment' : 'live';
    }
    catch {
        _cachedMode = 'live';
    }
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    return _cachedMode;
}
export async function setMode(mode) {
    const coreApi = getCoreApi();
    try {
        const existing = await coreApi.readNamespacedConfigMap({
            name: MODE_CM_NAME,
            namespace: MODE_NAMESPACE,
        });
        await coreApi.replaceNamespacedConfigMap({
            name: MODE_CM_NAME,
            namespace: MODE_NAMESPACE,
            body: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: {
                    name: MODE_CM_NAME,
                    namespace: MODE_NAMESPACE,
                    resourceVersion: existing.metadata?.resourceVersion,
                },
                data: { mode },
            },
        });
    }
    catch (error) {
        if (!isNotFound(error)) {
            throw error;
        }
        await coreApi.createNamespacedConfigMap({
            namespace: MODE_NAMESPACE,
            body: {
                apiVersion: 'v1',
                kind: 'ConfigMap',
                metadata: { name: MODE_CM_NAME, namespace: MODE_NAMESPACE },
                data: { mode },
            },
        });
    }
    _cachedMode = mode;
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    broadcastModeChange(mode);
}
export function registerBroadcastFn(fn) {
    _broadcastFn = fn;
}
function broadcastModeChange(mode) {
    _broadcastFn?.(mode);
}
//# sourceMappingURL=mode.js.map