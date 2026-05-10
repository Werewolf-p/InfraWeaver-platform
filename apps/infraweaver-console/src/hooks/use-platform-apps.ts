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
    const groups = (data?.groups ?? {}) as Record<string, { enabled?: boolean }>;

    const corePlatformEnabled = groups["core-platform"]?.enabled !== false;
    const coreMonitoringEnabled = groups["core-monitoring"]?.enabled !== false;

    return {
      // Always-on core apps
      argocd: true,
      longhorn: true,
      openbao: true,
      certManager: true,
      traefik: true,
      // Core-platform group
      grafana: corePlatformEnabled,
      authentik: corePlatformEnabled,
      netbird: corePlatformEnabled,
      // Core-monitoring group
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
