import { getArgocdAppsCached, type ArgoApplication } from "@/lib/argocd-apps";
import { HOMEPAGE_SERVICE_APP_MAP, type HomepageServiceHealth } from "@/lib/homepage-service-config";
import { safeError } from "@/lib/utils";

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

export function buildHomepageServiceHealthMap(apps: ArgoApplication[]) {
  const byName = new Map(
    apps
      .filter((app): app is ArgoApplication & { metadata: { name: string } } => Boolean(app.metadata?.name))
      .map((app) => [app.metadata.name, app]),
  );

  return Object.fromEntries(
    Object.entries(HOMEPAGE_SERVICE_APP_MAP).map(([name, appName]) => [
      name,
      buildServiceHealth(name, appName, byName.get(appName)),
    ]),
  ) as Record<string, HomepageServiceHealth>;
}

export async function getHomepageServiceHealthMap(apps?: ArgoApplication[]) {
  try {
    const sourceApps = apps ?? (await getArgocdAppsCached()).apps;
    return buildHomepageServiceHealthMap(sourceApps);
  } catch (error) {
    const reason = `Unable to query ArgoCD applications: ${getErrorMessage(error)}`;
    return Object.fromEntries(
      Object.entries(HOMEPAGE_SERVICE_APP_MAP).map(([name, appName]) => [
        name,
        { name, appName, status: "offline", reason },
      ]),
    ) as Record<string, HomepageServiceHealth>;
  }
}
