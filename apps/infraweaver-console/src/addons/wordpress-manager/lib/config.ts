/**
 * Env-driven configuration for the WordPress Manager addon. Nothing here is
 * hardcoded to a particular deployment: domains, the internal subdomain label,
 * the public DNS target, the forward-auth middleware and the cert issuer all come
 * from the environment so the addon works unchanged for any fork/operator.
 */

/** Split a comma/space separated env list into a clean, de-duplicated array. */
function envList(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

/**
 * The root domains an operator can deploy sites under (the create-form dropdown).
 * Falls back to BASE_DOMAIN so a single-domain deployment needs no extra config.
 */
export function listDomains(): string[] {
  const domains = envList(process.env.WORDPRESS_DOMAINS);
  if (domains.length > 0) return domains;
  const base = (process.env.WORDPRESS_BASE_DOMAIN || process.env.BASE_DOMAIN || "").trim().toLowerCase();
  return base ? [base] : [];
}

export function defaultDomain(): string {
  return listDomains()[0] ?? "";
}

/** Reject a domain that isn't one of the configured ones (defence in depth). */
export function isAllowedDomain(domain: string): boolean {
  return listDomains().includes(domain.trim().toLowerCase());
}

/** The label inserted for internal-only hosts, e.g. `int` → `<site>.int.<domain>`. */
export function internalSubdomain(): string {
  return (process.env.WORDPRESS_INTERNAL_SUBDOMAIN || "int").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
}

/**
 * Explicit CNAME target for public sites. When unset, a public subdomain CNAMEs
 * to its own root domain (which the operator already points at their ingress),
 * so no IP is ever baked in.
 */
export function publicCnameTarget(): string | undefined {
  const v = (process.env.WORDPRESS_PUBLIC_CNAME || "").trim().toLowerCase();
  return v || undefined;
}

/** Whether Cloudflare-proxied records should be created (default true). */
export function publicDnsProxied(): boolean {
  return (process.env.WORDPRESS_PUBLIC_DNS_PROXIED || "true").toLowerCase() !== "false";
}

/** Parse a `<namespace>/<name>` middleware ref, defaulting the namespace. */
function parseMiddlewareRef(raw: string, fallbackNamespace: string): { name: string; namespace: string } {
  const v = raw.trim();
  const [namespace, name] = v.includes("/") ? v.split("/", 2) : [fallbackNamespace, v];
  return { name, namespace };
}

/** The Traefik forward-auth (Authentik) middleware reference, as `<namespace>/<name>`. */
export function forwardAuthMiddleware(): { name: string; namespace: string } {
  return parseMiddlewareRef(process.env.WORDPRESS_FORWARD_AUTH_MIDDLEWARE || "traefik/forward-auth", "traefik");
}

/** The Traefik secure-headers middleware reference, as `<namespace>/<name>`. */
export function secureHeadersMiddleware(): { name: string; namespace: string } {
  return parseMiddlewareRef(process.env.WORDPRESS_SECURE_HEADERS_MIDDLEWARE || "traefik/secure-headers", "traefik");
}

/** The cert resolver / ClusterIssuer name for TLS; empty = Traefik default cert. */
export function certIssuer(): string {
  return (process.env.WORDPRESS_CERT_ISSUER || "").trim();
}

/**
 * The Authentik embedded-outpost service that serves the `/outpost.goauthentik.io/`
 * paths (auth check, start, callback). When a site is gated by forward-auth,
 * Authentik redirects the browser back to `https://<host>/outpost.goauthentik.io/
 * callback?...`; that navigation must reach the outpost, not WordPress, or it 404s
 * on the WP theme. The site's IngressRoute therefore routes that prefix to this
 * service (cross-namespace, which Traefik allows). Configurable as
 * `<namespace>/<name>:<port>`; defaults to Authentik's standard embedded outpost.
 */
export function authentikOutpostService(): { name: string; namespace: string; port: number } {
  const raw = (process.env.WORDPRESS_AUTHENTIK_OUTPOST_SERVICE || "authentik/authentik-server:80").trim();
  const [ref, portStr] = raw.split(":", 2);
  const { name, namespace } = parseMiddlewareRef(ref, "authentik");
  const port = Number.parseInt(portStr ?? "", 10);
  return { name, namespace, port: Number.isFinite(port) && port > 0 ? port : 80 };
}

/** The Authentik base issuer URL used to wire OIDC SSO during provisioning. */
export function authentikIssuerBase(): string {
  return (process.env.WORDPRESS_AUTHENTIK_ISSUER || process.env.AUTHENTIK_URL_PUBLIC || "").trim().replace(/\/+$/, "");
}

/**
 * Backchannel hostAlias for the OIDC server-side calls (token/userinfo/jwks).
 *
 * The OIDC issuer host (e.g. auth.rlservers.com) is a public, Cloudflare-fronted
 * name. From inside the cluster the WordPress pod cannot reach it: resolving the
 * public name NAT-hairpins back through the homelab's own edge and times out, and
 * the Traefik LB path is not reachable pod-internally. So we pin the issuer host to
 * Authentik's in-cluster Service IP via a pod hostAlias — the backchannel then goes
 * pod → authentik-server directly over plain http (:9000; see buildOidcSettings for
 * why http rather than the self-signed :9443), while the Host header stays the public
 * name. The browser (front-channel) is unaffected — a hostAlias only changes the
 * pod's own resolution, and the authorize/end-session URLs stay https.
 *
 * Requires `WORDPRESS_AUTHENTIK_BACKCHANNEL_IP` (the authentik-server ClusterIP) and
 * a resolvable issuer host. Returns undefined when not configured, in which case no
 * hostAlias is added and the plugin uses normal DNS (only viable when the issuer host
 * resolves to a pod-reachable address, e.g. a split-horizon internal DNS record).
 */
export function authentikBackchannelHostAlias(): { ip: string; hostnames: string[] } | undefined {
  const ip = (process.env.WORDPRESS_AUTHENTIK_BACKCHANNEL_IP || "").trim();
  const base = authentikIssuerBase();
  if (!ip || !base) return undefined;
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  return { ip, hostnames: [host] };
}

/** The local WordPress admin username seeded by `wp core install`. */
export function adminUser(): string {
  return (process.env.WORDPRESS_ADMIN_USER || "admin").trim();
}

/**
 * The local admin's email. Matching it to the operator's Authentik email lets the
 * OIDC plugin's `link_existing_users` log that person straight into the admin
 * account on SSO — no separate WordPress credentials. Falls back to the platform
 * `ADMIN_EMAILS`, then to `admin@<domain>`.
 */
export function adminEmail(domain?: string): string {
  const explicit = (process.env.WORDPRESS_ADMIN_EMAIL || "").trim();
  if (explicit) return explicit;
  const admins = envList(process.env.ADMIN_EMAILS);
  if (admins.length > 0) return admins[0];
  return domain ? `admin@${domain}` : "admin@example.com";
}
