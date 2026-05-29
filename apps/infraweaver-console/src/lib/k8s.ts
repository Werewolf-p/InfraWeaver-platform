import * as k8s from "@kubernetes/client-node";
import { getClusterConfig } from "@/lib/cluster-context";

// Cluster configuration is derived from process env (CLUSTER_CONTEXTS / KUBECONFIG)
// and does not change during the process lifetime, while building a KubeConfig
// performs base64 decoding, YAML parsing and/or filesystem reads. Memoize one
// KubeConfig per cluster so every API route reuses the same parsed config instead
// of reloading it on each request.
const DEFAULT_KUBECONFIG_KEY = "__default__";
const kubeConfigCache = new Map<string, k8s.KubeConfig>();

function buildKubeConfig(clusterId?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  const clusterConfig = clusterId ? getClusterConfig(clusterId) : undefined;

  if (clusterConfig?.kubeconfig) {
    kc.loadFromString(Buffer.from(clusterConfig.kubeconfig, "base64").toString("utf-8"));
    return kc;
  }

  try {
    kc.loadFromCluster();
  } catch {
    if (process.env.KUBECONFIG) kc.loadFromFile(process.env.KUBECONFIG);
    else kc.loadFromDefault();
  }

  return kc;
}

export function loadKubeConfig(clusterId?: string): k8s.KubeConfig {
  const cacheKey = clusterId ?? DEFAULT_KUBECONFIG_KEY;
  const cached = kubeConfigCache.get(cacheKey);
  if (cached) return cached;

  const kc = buildKubeConfig(clusterId);
  kubeConfigCache.set(cacheKey, kc);
  return kc;
}
