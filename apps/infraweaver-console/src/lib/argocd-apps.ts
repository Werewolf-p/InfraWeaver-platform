import * as k8s from "@kubernetes/client-node";
import { apiCache } from "@/lib/api-cache";
import { loadKubeConfig } from "@/lib/k8s";
import { PERFORMANCE_CACHE_KEYS } from "@/lib/performance-cache";
import { requestDedup } from "@/lib/request-dedup";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";
const ARGOCD_CACHE_TTL_MS = 15_000;
const LAST_KNOWN_APPS_TTL_MS = 600_000;

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

let lastKnownApps: ArgoApplication[] | null = null;
let lastKnownAppsAt = 0;

function rememberApps(apps: ArgoApplication[]) {
  lastKnownApps = apps;
  lastKnownAppsAt = Date.now();
  return apps;
}

function buildMockApps(): ArgoApplication[] {
  const apps = [
    { name: "bootstrap", namespace: "argocd", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-argocd-manifests", namespace: "argocd", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-cert-manager", namespace: "cert-manager", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-traefik", namespace: "traefik", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-external-secrets-manifests", namespace: "external-secrets", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-longhorn", namespace: "longhorn-system", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-authentik", namespace: "authentik", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-netbird", namespace: "netbird", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "apps-netbird", namespace: "netbird", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-grafana", namespace: "grafana", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "catalog-gatus-manifests", namespace: "gatus", project: "platform", health: "Healthy", sync: "Synced" },
  ];

  return apps.map((app) => ({
    metadata: { name: app.name, namespace: app.namespace, labels: {} },
    spec: { destination: { namespace: app.namespace, server: "https://kubernetes.default.svc" }, project: app.project },
    status: {
      health: { status: app.health },
      sync: { status: app.sync },
      summary: { images: [] },
    },
  }));
}

async function listApplicationCrds() {
  try {
    const customObjectsApi = loadKubeConfig().makeApiClient(k8s.CustomObjectsApi);
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

async function fetchArgocdAppsUncached(): Promise<ArgoApplication[]> {
  try {
    const response = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=500`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json() as { items?: ArgoApplication[] };
      return rememberApps(Array.isArray(data.items) ? data.items : []);
    }
  } catch {
    // Fall back to CRDs below.
  }

  const crdItems = await listApplicationCrds();
  if (crdItems) {
    return rememberApps(crdItems);
  }

  if (lastKnownApps && Date.now() - lastKnownAppsAt < LAST_KNOWN_APPS_TTL_MS) {
    return lastKnownApps;
  }

  return rememberApps(buildMockApps());
}

export async function getArgocdAppsCached() {
  const cached = apiCache.get<ArgoApplication[]>(PERFORMANCE_CACHE_KEYS.argocdApps);
  if (cached) {
    return { apps: cached, cacheStatus: "HIT" as const };
  }

  const apps = await requestDedup.dedupe(PERFORMANCE_CACHE_KEYS.argocdApps, async () => {
    const fresh = await fetchArgocdAppsUncached();
    apiCache.set(PERFORMANCE_CACHE_KEYS.argocdApps, fresh, ARGOCD_CACHE_TTL_MS);
    return fresh;
  });

  return { apps, cacheStatus: "MISS" as const };
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
