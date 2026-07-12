import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "@/lib/k8s";

/** Singleton KubeConfig. Loaded once per process. */
let _kc: k8s.KubeConfig | null = null;

/**
 * Returns the process-wide KubeConfig. When `clusterId` is provided, delegates
 * to the multi-cluster-aware (and per-cluster cached) loader in `@/lib/k8s`;
 * when omitted, behavior is unchanged from the original single-cluster
 * singleton (KUBECONFIG env file, else in-cluster, else default).
 */
export function makeKc(clusterId?: string): k8s.KubeConfig {
  if (clusterId) return loadKubeConfig(clusterId);
  if (_kc) return _kc;
  _kc = new k8s.KubeConfig();
  if (process.env.KUBECONFIG) {
    _kc.loadFromFile(process.env.KUBECONFIG);
  } else {
    try { _kc.loadFromCluster(); } catch { _kc.loadFromDefault(); }
  }
  return _kc;
}

export function makeCoreApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.CoreV1Api); }
export function makeAppsApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.AppsV1Api); }
export function makeCustomApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.CustomObjectsApi); }
export function makeBatchApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.BatchV1Api); }
export function makeRbacApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.RbacAuthorizationV1Api); }
export function makeNetworkApi(clusterId?: string) { return makeKc(clusterId).makeApiClient(k8s.NetworkingV1Api); }

/**
 * Unwraps a Kubernetes list response's `.items`, tolerating responses without
 * one (metrics.k8s.io custom-object lists are typed as plain objects). Replaces
 * the `(res as { items?: T[] }).items ?? []` casts scattered across API routes.
 */
export function listItems<T>(res: unknown): T[] {
  return (res as { items?: T[] } | null | undefined)?.items ?? [];
}
