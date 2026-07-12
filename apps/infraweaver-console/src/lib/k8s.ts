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

/**
 * Lists custom objects (cluster-scoped, or namespaced when `namespace` is set)
 * and unwraps `.items`. The v1.x client types these responses as plain objects,
 * so every call site casts to `{ items?: T[] }` — this centralizes that cast.
 */
export async function listCustomItems<T>(
  customApi: k8s.CustomObjectsApi,
  params: { group: string; version: string; plural: string; namespace?: string },
): Promise<T[]> {
  const { group, version, plural, namespace } = params;
  const res = namespace
    ? await customApi.listNamespacedCustomObject({ group, version, plural, namespace })
    : await customApi.listClusterCustomObject({ group, version, plural });
  return (res as { items?: T[] } | null | undefined)?.items ?? [];
}

/**
 * Create-or-update a namespaced custom object via server-side apply (one PATCH
 * with `application/apply-patch+yaml`), replacing the manual GET → resourceVersion
 * → PUT/POST upsert dance. `force: true` matches kubectl's conflict behavior for
 * a single-owner field manager.
 */
export async function upsertNamespacedCustomObject(
  customApi: k8s.CustomObjectsApi,
  params: { group: string; version: string; namespace: string; plural: string; name: string; body: Record<string, unknown> },
): Promise<void> {
  await customApi.patchNamespacedCustomObject(
    { ...params, fieldManager: "infraweaver", force: true },
    k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.ServerSideApply),
  );
}

/**
 * Extracts the fulfilled values from a Promise.allSettled result, dropping
 * rejections. For fan-out reads where partial results are acceptable — callers
 * that must surface failures should inspect the rejected entries themselves.
 */
export function settledItems<T>(results: PromiseSettledResult<T>[]): T[] {
  return results
    .filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled")
    .map((result) => result.value);
}
