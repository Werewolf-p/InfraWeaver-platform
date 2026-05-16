import { createHmac, timingSafeEqual } from "node:crypto";

export interface ClusterConfig {
  id: string;
  displayName: string;
  kubeconfig?: string;
  argocdServer?: string;
  argocdToken?: string;
  description?: string;
  tags?: string[];
  isLocal?: boolean;
  gatusUrl?: string;
}

export const ACTIVE_CLUSTER_COOKIE = "infraweaver-cluster";

function getCookieSecret() {
  return process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "infraweaver-cluster-secret";
}

export function getClusterConfigs(): ClusterConfig[] {
  const raw = process.env.CLUSTER_CONTEXTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ClusterConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.filter((cluster): cluster is ClusterConfig => Boolean(cluster?.id && cluster?.displayName));
        if (valid.length > 0) return valid;
      }
    } catch {
      // Fall through to single-cluster defaults.
    }
  }

  return [{
    id: "default",
    displayName: process.env.CLUSTER_DISPLAY_NAME ?? "Production",
    argocdServer: process.env.ARGOCD_SERVER,
    argocdToken: process.env.ARGOCD_TOKEN,
  }];
}

export function getClusterConfig(id: string): ClusterConfig | undefined {
  return getClusterConfigs().find((cluster) => cluster.id === id);
}

export function getDefaultClusterId() {
  const configs = getClusterConfigs();
  return configs.find((cluster) => cluster.id === "default")?.id ?? configs[0]?.id ?? "default";
}

function signClusterId(clusterId: string) {
  return createHmac("sha256", getCookieSecret()).update(clusterId).digest("hex");
}

export function serializeActiveClusterCookie(clusterId: string) {
  return `${clusterId}.${signClusterId(clusterId)}`;
}

export function parseActiveClusterCookie(value?: string | null) {
  if (!value) return undefined;

  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return undefined;

  const clusterId = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expected = signClusterId(clusterId);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) return undefined;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;

  return clusterId;
}

export function getActiveClusterIdFromCookieValue(value?: string | null) {
  const clusterId = parseActiveClusterCookie(value);
  return clusterId && getClusterConfig(clusterId) ? clusterId : getDefaultClusterId();
}

/**
 * Reads the active cluster ID from the request cookie.
 * Falls back to the default cluster ID if cookie is absent or invalid.
 * Use in every API route that touches a cluster-specific resource.
 */
export function getRequestClusterId(request: import("next/server").NextRequest): string {
  return getActiveClusterIdFromCookieValue(request.cookies.get(ACTIVE_CLUSTER_COOKIE)?.value);
}
