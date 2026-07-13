/**
 * Nextcloud adapter configuration — how the console reaches the in-cluster server
 * and the admin credential it acts with.
 *
 * The console pod talks to Nextcloud over the cluster-internal Service
 * (`nextcloud.nextcloud.svc`), NOT the public ingress: going in-cluster avoids a
 * hairpin through Cloudflare and the forward-auth outpost. Nothing here is secret —
 * the OCS admin credential lives in OpenBao (`secret/platform/nextcloud`, projected
 * to env by ESO); this module only reads it back from the environment.
 */
import "server-only";

/** App slug — namespaces the OpenBao credentials (shared app-accounts store). */
export const NEXTCLOUD_APP_ID = "nextcloud";
export const NEXTCLOUD_APP_LABEL = "Nextcloud";

/** OCS calls are bounded so a hung Nextcloud never wedges a console request. */
export const OCS_TIMEOUT_MS = Number(process.env.NEXTCLOUD_TIMEOUT_MS) || 10_000;

/** In-cluster base URL for Nextcloud's OCS API; the svc DNS name is a trusted domain. */
export function nextcloudBaseUrl(): string {
  return (process.env.NEXTCLOUD_URL || "http://nextcloud.nextcloud.svc.cluster.local").replace(/\/+$/, "");
}

/** The URL a user opens to sign in — goes in the credential reveal for hand-off. */
export function nextcloudLaunchUrl(): string {
  if (process.env.NEXTCLOUD_PUBLIC_URL) return process.env.NEXTCLOUD_PUBLIC_URL.replace(/\/+$/, "");
  const domain = process.env.BASE_DOMAIN || process.env.NEXT_PUBLIC_BASE_DOMAIN;
  return domain ? `https://nextcloud.int.${domain}` : nextcloudBaseUrl();
}

export interface NextcloudAdmin {
  user: string;
  password: string;
}

/** The OCS admin credential the platform holds in OpenBao (projected to env by ESO). */
export function nextcloudAdmin(): NextcloudAdmin | null {
  const user = (process.env.NEXTCLOUD_ADMIN_USER || "").trim();
  const password = process.env.NEXTCLOUD_ADMIN_PASSWORD || "";
  if (!user || !password) return null;
  return { user, password };
}

/** True when the console has the admin credential needed to act on Nextcloud users. */
export function isNextcloudConfigured(): boolean {
  return nextcloudAdmin() !== null;
}

/** Basic-auth header for an OCS admin request. */
export function nextcloudAuthHeader(admin: NextcloudAdmin): string {
  return `Basic ${Buffer.from(`${admin.user}:${admin.password}`).toString("base64")}`;
}
