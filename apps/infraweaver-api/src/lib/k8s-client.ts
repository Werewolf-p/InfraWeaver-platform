import * as k8s from '@kubernetes/client-node';
import { getCluster, getClusterKubeconfig } from './cluster-registry.js';

const _clients = new Map<string, k8s.KubeConfig>();

export async function getKcForCluster(clusterId: string): Promise<k8s.KubeConfig> {
  if (_clients.has(clusterId)) {
    return _clients.get(clusterId)!;
  }

  const kc = new k8s.KubeConfig();

  // Treat 'local' and any cluster marked isLocal as the in-cluster config.
  const clusterMeta = clusterId !== 'local' ? await getCluster(clusterId).catch(() => null) : null;
  if (clusterId === 'local' || clusterMeta?.isLocal) {
    try {
      kc.loadFromCluster();
    } catch {
      kc.loadFromDefault();
    }
  } else {
    const kubeconfig = await getClusterKubeconfig(clusterId);
    kc.loadFromString(kubeconfig);
  }

  _clients.set(clusterId, kc);
  return kc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeApiClient<T>(clusterId: string, ApiClass: new (...args: any[]) => T): Promise<T> {
  const kc = await getKcForCluster(clusterId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return kc.makeApiClient(ApiClass as any) as unknown as T;
}

export const getCoreApiForCluster       = (id: string) => makeApiClient(id, k8s.CoreV1Api);
export const getAppsApiForCluster       = (id: string) => makeApiClient(id, k8s.AppsV1Api);
export const getCustomApiForCluster     = (id: string) => makeApiClient(id, k8s.CustomObjectsApi);
export const getBatchApiForCluster      = (id: string) => makeApiClient(id, k8s.BatchV1Api);
export const getNetworkApiForCluster    = (id: string) => makeApiClient(id, k8s.NetworkingV1Api);
export const getAutoscalingApiForCluster = (id: string) => makeApiClient(id, k8s.AutoscalingV2Api);
export const getPolicyApiForCluster     = (id: string) => makeApiClient(id, k8s.PolicyV1Api);
