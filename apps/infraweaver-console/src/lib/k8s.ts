import * as k8s from "@kubernetes/client-node";
import { getClusterConfig } from "@/lib/cluster-context";

export function loadKubeConfig(clusterId?: string): k8s.KubeConfig {
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
