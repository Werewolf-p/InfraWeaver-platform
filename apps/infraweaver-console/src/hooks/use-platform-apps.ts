"use client";
import { usePlatformConfig } from "./use-platform-config";
import { useMemo } from "react";

interface PlatformApps {
  argocd: boolean;
  longhorn: boolean;
  openbao: boolean;
  certManager: boolean;
  traefik: boolean;
  grafana: boolean;
  authentik: boolean;
  netbird: boolean;
  velero: boolean;
  falco: boolean;
  loki: boolean;
  prometheus: boolean;
  gatus: boolean;
  wiki: boolean;
  registry: boolean;
  gitea: boolean;
  vaultwarden: boolean;
  uptimeKuma: boolean;
}

export function usePlatformApps(): PlatformApps {
  const { data } = usePlatformConfig();
  return useMemo(() => {
    const catalog = (data?.catalog as { enabled?: string[] })?.enabled ?? [];
    const groups = (data?.groups ?? {}) as Record<string, { enabled?: boolean; apps?: Record<string, { enabled?: boolean }> }>;

    const corePlatformEnabled = groups["core-platform"]?.enabled !== false;
    const coreMonitoringEnabled = groups["core-monitoring"]?.enabled === true;

    // Per-app flags within core-platform (optional apps have enabled: false by default)
    const platformApps = groups["core-platform"]?.apps ?? {};
    const appEnabled = (name: string) =>
      corePlatformEnabled && platformApps[name]?.enabled !== false;

    return {
      // Always-on core apps
      argocd: true,
      longhorn: true,
      openbao: true,
      certManager: true,
      traefik: true,
      // Core-platform required apps (always on when group is enabled)
      authentik: corePlatformEnabled,
      // Core-platform optional apps
      grafana: appEnabled("grafana"),
      netbird: appEnabled("netbird"),
      velero: appEnabled("velero"),
      falco: appEnabled("falco"),
      // Core-monitoring group (entirely optional)
      loki: coreMonitoringEnabled,
      prometheus: coreMonitoringEnabled,
      // Catalog apps
      gatus: catalog.includes("gatus"),
      wiki: catalog.includes("wiki"),
      registry: catalog.includes("registry"),
      gitea: catalog.includes("gitea"),
      vaultwarden: catalog.includes("vaultwarden"),
      uptimeKuma: catalog.includes("uptime-kuma"),
    };
  }, [data]);
}
