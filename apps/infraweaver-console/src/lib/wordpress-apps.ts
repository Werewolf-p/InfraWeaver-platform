/**
 * WordPress sites as first-class entries on the Apps page.
 *
 * Sites are provisioned imperatively by the wordpress-manager addon (never as
 * ArgoCD Applications), so the Apps list adapts their runtime state into the
 * same row model it uses for catalog/community apps. Kept framework-free so the
 * mapping can be unit-tested without React.
 */

/** Mirrors SiteSummary from the wordpress-manager addon's /api/wordpress/sites. */
export interface WordpressSiteSummary {
  site: string;
  host: string;
  ready: boolean;
  replicas: number;
  domain?: string;
  internal?: boolean;
  authMode?: "none" | "login" | "admin" | "full";
  setupPending?: boolean;
  dnsWarning?: string;
}

/** Every WordPress site deploys into this shared namespace. */
export const WORDPRESS_APPS_NAMESPACE = "wordpress";

export type WordpressAppHealth = "healthy" | "progressing" | "degraded";

/**
 * A site's health in Apps-page terms: serving traffic is healthy, trying to
 * come up (replicas requested but none ready) is progressing, and scaled to
 * zero — or otherwise unable to even request a pod — is degraded.
 */
export function wordpressSiteHealth(site: Pick<WordpressSiteSummary, "ready" | "replicas">): WordpressAppHealth {
  if (site.ready) return "healthy";
  return site.replicas > 0 ? "progressing" : "degraded";
}

/** Where a WordPress site's app detail lives (the site management panel). */
export function wordpressSiteHref(site: string): string {
  return `/wordpress/${encodeURIComponent(site)}`;
}
