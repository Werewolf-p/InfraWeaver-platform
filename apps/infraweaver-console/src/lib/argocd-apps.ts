import * as k8s from "@kubernetes/client-node";
import { apiCache } from "@/lib/api-cache";
import { getClusterConfig, getDefaultClusterId } from "@/lib/cluster-context";
import { loadKubeConfig } from "@/lib/k8s";
import { PERFORMANCE_CACHE_KEYS } from "@/lib/performance-cache";
import { argocdApiBase } from "@/lib/platform-config";
import { requestDedup } from "@/lib/request-dedup";

const DEFAULT_ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const DEFAULT_ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";
const ARGOCD_CACHE_TTL_MS = 15_000;
const LAST_KNOWN_APPS_TTL_MS = 600_000;

/**
 * Shared fetch against the ArgoCD API. Resolves the base URL via
 * {@link argocdApiBase} and attaches the bearer token + JSON content-type so
 * route handlers don't re-derive the server URL or repeat auth boilerplate.
 * `path` must start with "/" (e.g. "/api/v1/applications").
 */
export function argocdFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${argocdApiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${DEFAULT_ARGOCD_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export type ArgoAppsDataSource = "argocd-api" | "crd" | "last-known" | "unavailable";

export interface ArgoApplication {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string>; creationTimestamp?: string };
  spec?: {
    destination?: { namespace?: string; server?: string };
    project?: string;
    source?: { repoURL?: string; path?: string; targetRevision?: string };
  };
  status?: {
    health?: { status?: string };
    sync?: { status?: string; revision?: string };
    conditions?: Array<{ type?: string; message?: string; lastTransitionTime?: string }>;
    operationState?: {
      phase?: string;
      startedAt?: string;
      finishedAt?: string;
      message?: string;
      syncResult?: { revision?: string };
    };
    summary?: { images?: string[]; externalURLs?: string[] };
    reconciledAt?: string;
  };
}

export interface ArgoAppSummary {
  degraded: number;
  healthy: number;
  issues: number;
  outOfSync: number;
  progressing: number;
  status: "healthy" | "degraded" | "progressing" | "unknown";
  total: number;
}

interface LastKnownAppsEntry {
  apps: ArgoApplication[];
  at: number;
}

interface ArgocdAppsFetchResult {
  apps: ArgoApplication[];
  dataSource: ArgoAppsDataSource;
}

const lastKnownApps = new Map<string, LastKnownAppsEntry>();

function getClusterCacheKey(clusterId?: string) {
  return clusterId ?? getDefaultClusterId();
}

function getArgocdConnection(clusterId?: string) {
  const resolvedClusterId = getClusterCacheKey(clusterId);
  const clusterConfig = getClusterConfig(resolvedClusterId);

  return {
    clusterId: resolvedClusterId,
    server: clusterConfig?.argocdServer ?? DEFAULT_ARGOCD_SERVER,
    token: clusterConfig?.argocdToken ?? DEFAULT_ARGOCD_TOKEN,
  };
}

function rememberApps(clusterId: string, apps: ArgoApplication[]) {
  lastKnownApps.set(clusterId, { apps, at: Date.now() });
  return apps;
}

function getLastKnownApps(clusterId: string) {
  const cached = lastKnownApps.get(clusterId);
  if (!cached) return null;
  if (Date.now() - cached.at >= LAST_KNOWN_APPS_TTL_MS) return null;
  return cached.apps;
}


async function listApplicationCrds(clusterId?: string) {
  try {
    const customObjectsApi = loadKubeConfig(clusterId).makeApiClient(k8s.CustomObjectsApi);
    const response = await customObjectsApi.listNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
    }) as { items?: ArgoApplication[] };

    return Array.isArray(response.items) ? response.items : [];
  } catch {
    return null;
  }
}

async function fetchArgocdAppsUncached(clusterId?: string): Promise<ArgocdAppsFetchResult> {
  const connection = getArgocdConnection(clusterId);

  try {
    const response = await fetch(`${connection.server}/api/v1/applications?limit=500`, {
      headers: {
        ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json() as { items?: ArgoApplication[] };
      return {
        apps: rememberApps(connection.clusterId, Array.isArray(data.items) ? data.items : []),
        dataSource: "argocd-api",
      };
    }
  } catch {
    // Fall back to CRDs below.
  }

  const crdItems = await listApplicationCrds(clusterId);
  if (crdItems) {
    return {
      apps: rememberApps(connection.clusterId, crdItems),
      dataSource: "crd",
    };
  }

  const cached = getLastKnownApps(connection.clusterId);
  if (cached) {
    return { apps: cached, dataSource: "last-known" };
  }

  return {
    apps: [],
    dataSource: "unavailable",
  };
}

export async function getArgocdAppsCached(clusterId?: string) {
  const cacheKey = `${PERFORMANCE_CACHE_KEYS.argocdApps}:${getClusterCacheKey(clusterId)}`;
  const cached = apiCache.get<ArgocdAppsFetchResult>(cacheKey);
  if (cached) {
    return { ...cached, cacheStatus: "HIT" as const };
  }

  const result = await requestDedup.dedupe(cacheKey, async () => {
    const fresh = await fetchArgocdAppsUncached(clusterId);
    apiCache.set(cacheKey, fresh, ARGOCD_CACHE_TTL_MS);
    return fresh;
  });

  return { ...result, cacheStatus: "MISS" as const };
}

export function summarizeArgocdApps(apps: ArgoApplication[]): ArgoAppSummary {
  const healthy = apps.filter((app) => app.status?.health?.status === "Healthy").length;
  const degraded = apps.filter((app) => app.status?.health?.status === "Degraded").length;
  const progressing = apps.filter((app) => app.status?.health?.status === "Progressing").length;
  const outOfSync = apps.filter((app) => app.status?.sync?.status === "OutOfSync").length;
  const total = apps.length;
  const issues = apps.filter((app) => ["Degraded", "Failed", "Missing"].includes(app.status?.health?.status ?? "")).length;
  const status = degraded > 0 ? "degraded" : progressing > 0 ? "progressing" : healthy > 0 ? "healthy" : "unknown";

  return { degraded, healthy, issues, outOfSync, progressing, status, total };
}
