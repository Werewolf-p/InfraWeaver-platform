/**
 * Jellyfin adapter configuration — how the console reaches the in-cluster server
 * and where its service-account credential lives.
 *
 * The console pod talks to Jellyfin over the cluster-internal Service
 * (`jellyfin.jellyfin.svc`), NOT the public ingress: the ingress deliberately has
 * no forward-auth (native clients need Jellyfin's own auth), and going in-cluster
 * avoids a hairpin through Cloudflare. Nothing here is secret — the API key and the
 * service-account password live in OpenBao (see store.ts / provider.ts).
 */

/** App slug — namespaces the OpenBao roster/credentials and the notifications. */
export const JELLYFIN_APP_ID = "jellyfin";
export const JELLYFIN_APP_LABEL = "Jellyfin";

/** The local admin account InfraWeaver manages the server with. Never provisioned
 *  from RBAC and never disabled by the reconcile (it is the reconcile's own hands). */
export function jellyfinServiceAccountUsername(): string {
  return process.env.JELLYFIN_SERVICE_ACCOUNT || "infraweaver-service";
}

/** In-cluster base URL for the admin API. Overridable for tests / non-default DNS. */
export function jellyfinBaseUrl(): string {
  return (process.env.JELLYFIN_URL || "http://jellyfin.jellyfin.svc.cluster.local:8096").replace(/\/+$/, "");
}

/** The URL a provisioned user opens to sign in — goes in their credential notification. */
export function jellyfinLaunchUrl(): string {
  if (process.env.JELLYFIN_PUBLIC_URL) return process.env.JELLYFIN_PUBLIC_URL.replace(/\/+$/, "");
  const domain = process.env.BASE_DOMAIN || process.env.NEXT_PUBLIC_BASE_DOMAIN;
  return domain ? `https://jellyfin.int.${domain}` : jellyfinBaseUrl();
}

/** OpenBao secret name (under the jellyfin app) holding the service-account creds. */
export const JELLYFIN_SERVICE_SECRET = "service-account";

/**
 * One-time bootstrap admin token/credential the operator may supply when Jellyfin's
 * first-run wizard was already completed by hand (so the console cannot self-mint an
 * API key from the wizard). Consumed once to create the InfraWeaver API key, then it
 * should be removed. Empty when unset.
 */
export function jellyfinBootstrapToken(): string {
  return (process.env.JELLYFIN_BOOTSTRAP_TOKEN || "").trim();
}
