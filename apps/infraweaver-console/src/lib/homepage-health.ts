import { makeCustomApi } from "@/lib/kube-client";
import { HOMEPAGE_SERVICE_APP_MAP, type HomepageServiceHealth } from "@/lib/homepage-service-config";
import { safeError } from "@/lib/utils";

interface ArgoApplication {
  metadata?: { name?: string };
  status?: {
    health?: { status?: string };
    sync?: { status?: string };
  };
}

let cachedHealth: Record<string, HomepageServiceHealth> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function getErrorMessage(error: unknown) {
  return safeError(error);
}

function buildServiceHealth(name: string, appName: string, app?: ArgoApplication): HomepageServiceHealth {
  if (!app) {
    return {
      name,
      appName,
      status: "offline",
      reason: `ArgoCD application ${appName} not found`,
    };
  }

  const health = app.status?.health?.status;
  const sync = app.status?.sync?.status;

  if (health === "Healthy" && (!sync || sync === "Synced")) {
    return { name, appName, status: "healthy" };
  }

  const reasons: string[] = [];
  if (health && health !== "Healthy") reasons.push(`health: ${health}`);
  if (sync && sync !== "Synced") reasons.push(`sync: ${sync}`);

  if (reasons.length > 0) {
    return {
      name,
      appName,
      status: "degraded",
      reason: reasons.join(", "),
    };
  }

  return {
    name,
    appName,
    status: "offline",
    reason: "ArgoCD application has no health data",
  };
}

export async function getHomepageServiceHealthMap() {
  if (cachedHealth && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedHealth;
  }

  try {
    const customApi = makeCustomApi();
    const response = await customApi.listNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
      limit: 500,
    }) as { items?: ArgoApplication[] };

    const byName = new Map(
      (response.items ?? [])
        .filter((app): app is ArgoApplication & { metadata: { name: string } } => Boolean(app.metadata?.name))
        .map((app) => [app.metadata.name, app])
    );

    cachedHealth = Object.fromEntries(
      Object.entries(HOMEPAGE_SERVICE_APP_MAP).map(([name, appName]) => [
        name,
        buildServiceHealth(name, appName, byName.get(appName)),
      ])
    );
    cachedAt = Date.now();
    return cachedHealth;
  } catch (error) {
    if (cachedHealth) return cachedHealth;

    const reason = `Unable to query ArgoCD applications: ${getErrorMessage(error)}`;
    return Object.fromEntries(
      Object.entries(HOMEPAGE_SERVICE_APP_MAP).map(([name, appName]) => [
        name,
        { name, appName, status: "offline", reason },
      ])
    ) as Record<string, HomepageServiceHealth>;
  }
}
