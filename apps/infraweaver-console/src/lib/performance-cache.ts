import { apiCache } from "@/lib/api-cache";

export const PERFORMANCE_CACHE_KEYS = {
  argocdApps: "argocd:apps:list",
  clusterMetrics: "cluster:metrics:list",
  clusterNodes: "cluster:nodes:list",
  homeSummary: "home:summary",
} as const;

export function invalidateArgocdCaches() {
  apiCache.invalidate("argocd:apps:*");
  apiCache.invalidate("home:*");
}

export function invalidateClusterCaches() {
  apiCache.invalidate("cluster:nodes:*");
  apiCache.invalidate("cluster:metrics:*");
  apiCache.invalidate("home:*");
}

export function invalidatePodCaches() {
  apiCache.invalidate("home:*");
}
