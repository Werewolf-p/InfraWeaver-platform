import { internalSubdomain } from "./config";

/** A subdomain/site name: lowercase alphanumerics and hyphens, 3–32 chars. */
export const SITE_NAME_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/;
/** A derived k8s/vault site id (root-domain sites slugify the domain → up to 50). */
export const SITE_ID_RE = /^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/;

/** Valid as a user-typed subdomain (the create-form "Subdomain" field). */
export function isValidSiteName(name: string): boolean {
  return SITE_NAME_RE.test(name);
}

export function assertValidSiteName(name: string): string {
  if (!isValidSiteName(name)) {
    throw new Error(
      "Subdomain must be 3–32 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen",
    );
  }
  return name;
}

/** Valid as the internal resource id (derived from subdomain or domain). */
export function isValidSiteId(id: string): boolean {
  return SITE_ID_RE.test(id);
}

export function assertValidSiteId(id: string): string {
  if (!isValidSiteId(id)) {
    throw new Error(`Invalid site id "${id}" — could not derive a DNS-safe resource name`);
  }
  return id;
}

/** Slugify a domain into a DNS-1123 token: `rlservers.com` → `rlservers-com`. */
export function slugifyDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * A site placement: the optional subdomain `name` (empty ⇒ the root domain), the
 * root `domain`, and whether it's internal-only. Everything host-related derives
 * from this so nothing is hardcoded to one deployment.
 */
export interface SiteSpec {
  name: string;
  domain: string;
  internal: boolean;
}

/**
 * The stable k8s/vault id for a placement. A subdomain site keys on the subdomain
 * (back-compatible with the old single-name model); a root-domain site keys on the
 * slugified domain so two domains' roots don't collide.
 */
export function deriveSiteId(name: string, domain: string): string {
  const sub = name.trim().toLowerCase();
  return sub ? sub : slugifyDomain(domain);
}

/** The public host for a placement, e.g. `blog.int.rlservers.com` or `rlservers.com`. */
export function buildHost(spec: SiteSpec): string {
  const parts: string[] = [];
  if (spec.name) parts.push(spec.name);
  if (spec.internal) parts.push(internalSubdomain());
  parts.push(spec.domain);
  return parts.filter(Boolean).join(".").replace(/\.+/g, ".");
}

/**
 * Legacy host for a site that predates the domain model (no domain/internal labels
 * persisted). Falls back to BASE_DOMAIN, matching the original behaviour so old
 * sites keep resolving in listings.
 */
export function legacySiteHost(site: string, baseDomain = process.env.WORDPRESS_BASE_DOMAIN || process.env.BASE_DOMAIN || "int"): string {
  return `${site}.${baseDomain.replace(/^\.+|\.+$/g, "")}`;
}

/** Per-site resource names, all derived from the site id so they're stable. */
export function resourceNames(site: string) {
  return {
    wp: site,
    wpService: site,
    wpPvc: `${site}-wp-data`,
    wpSecret: `${site}-wp`,
    db: `${site}-db`,
    dbService: `${site}-db`,
    dbPvc: `${site}-db-data`,
    dbSecret: `${site}-db`,
    ingressRoute: site,
  } as const;
}
