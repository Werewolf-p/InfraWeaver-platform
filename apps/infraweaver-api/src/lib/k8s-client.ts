import * as k8s from '@kubernetes/client-node';
import { getClusterKubeconfig } from './cluster-registry.js';

const _clients = new Map<string, k8s.KubeConfig>();

export async function getKcForCluster(clusterId: string): Promise<k8s.KubeConfig> {
  if (_clients.has(clusterId)) {
    return _clients.get(clusterId)!;
  }

  const kc = new k8s.KubeConfig();
  if (clusterId === 'local') {
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

export async function getCoreApiForCluster(clusterId: string) {
  const kc = await getKcForCluster(clusterId);
  return kc.makeApiClient(k8s.CoreV1Api);
}

export async function getAppsApiForCluster(clusterId: string) {
  const kc = await getKcForCluster(clusterId);
  return kc.makeApiClient(k8s.AppsV1Api);
}

export async function getCustomApiForCluster(clusterId: string) {
  const kc = await getKcForCluster(clusterId);
  return kc.makeApiClient(k8s.CustomObjectsApi);
}

export async function getMetricsApiForCluster(clusterId: string) {
  const kc = await getKcForCluster(clusterId);
  return new k8s.Metrics(kc);
}
