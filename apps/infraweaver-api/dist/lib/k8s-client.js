import * as k8s from '@kubernetes/client-node';
import { getClusterKubeconfig } from './cluster-registry.js';
const _clients = new Map();
export async function getKcForCluster(clusterId) {
    if (_clients.has(clusterId)) {
        return _clients.get(clusterId);
    }
    const kc = new k8s.KubeConfig();
    if (clusterId === 'local') {
        try {
            kc.loadFromCluster();
        }
        catch {
            kc.loadFromDefault();
        }
    }
    else {
        const kubeconfig = await getClusterKubeconfig(clusterId);
        kc.loadFromString(kubeconfig);
    }
    _clients.set(clusterId, kc);
    return kc;
}
export async function getCoreApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.CoreV1Api);
}
export async function getAppsApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.AppsV1Api);
}
export async function getCustomApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.CustomObjectsApi);
}
export async function getMetricsApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return new k8s.Metrics(kc);
}
export async function getBatchApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.BatchV1Api);
}
export async function getNetworkApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.NetworkingV1Api);
}
export async function getAutoscalingApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.AutoscalingV2Api);
}
export async function getPolicyApiForCluster(clusterId) {
    const kc = await getKcForCluster(clusterId);
    return kc.makeApiClient(k8s.PolicyV1Api);
}
//# sourceMappingURL=k8s-client.js.map