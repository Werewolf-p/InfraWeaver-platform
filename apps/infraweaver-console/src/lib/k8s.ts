import * as k8s from "@kubernetes/client-node";

export function loadKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    if (process.env.KUBECONFIG) kc.loadFromFile(process.env.KUBECONFIG);
    else kc.loadFromDefault();
  }
  return kc;
}
