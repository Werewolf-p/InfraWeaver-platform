"use client";
import { usePlatformConfig } from "./use-platform-config";
import { useMemo } from "react";

export function usePlatformApps() {
  const { data } = usePlatformConfig();
  return useMemo(() => {
    if (!data?.raw) return {};
    const raw = data.raw;
    return {
      grafana: /grafana:\s*\n[^]*?enabled:\s*true/.test(raw),
      loki: /loki:\s*\n[^]*?enabled:\s*true/.test(raw),
      netbird: /netbird:\s*\n[^]*?enabled:\s*true/.test(raw),
      openbao: /openbao:\s*\n[^]*?enabled:\s*true/.test(raw),
      argocd: /argocd:\s*\n[^]*?enabled:\s*true/.test(raw),
      wiki: /wiki:\s*\n[^]*?enabled:\s*true/.test(raw),
      registry: /registry:\s*\n[^]*?enabled:\s*true/.test(raw),
      gatus: /gatus:\s*\n[^]*?enabled:\s*true/.test(raw),
      longhorn: /longhorn:\s*\n[^]*?enabled:\s*true/.test(raw),
    };
  }, [data]);
}
