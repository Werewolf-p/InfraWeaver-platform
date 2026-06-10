import { DEFAULT_HOMEPAGE_SERVICE_MAP } from "@/lib/platform-config";

export type HomepageServiceHealthState = "healthy" | "degraded" | "offline";

export interface HomepageServiceHealth {
  name: string;
  status: HomepageServiceHealthState;
  reason?: string;
  appName?: string;
}

// Service label → ArgoCD app name. Defined once in platform-config (single
// source of truth, derives external-route domains from identity); re-exported
// here for back-compat with existing import sites.
export const HOMEPAGE_SERVICE_APP_MAP: Record<string, string> = DEFAULT_HOMEPAGE_SERVICE_MAP;
