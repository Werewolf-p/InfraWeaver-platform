import { WORDPRESS_NAMESPACE } from "./wordpress-rbac";
import { resourceNames, legacySiteHost } from "./naming";
import { forwardAuthMiddleware, secureHeadersMiddleware, certIssuer as configCertIssuer } from "./config";

const DEFAULT_WP_IMAGE = process.env.WORDPRESS_IMAGE || "wordpress:6-php8.3-apache";
const DEFAULT_DB_IMAGE = process.env.WORDPRESS_DB_IMAGE || "mariadb:11";
const STORAGE_CLASS = process.env.WORDPRESS_STORAGE_CLASS || "local-path-retain";

// The official WordPress image ships no wp-cli, but the addon drives all
// post-provision setup (plugin install, OIDC client config) through `wp`. Rather
// than bake a bespoke image, an init container fetches a pinned, checksum-verified
// wp-cli phar into a shared volume that the WordPress container puts on its PATH,
// so `wp` resolves in-pod. Version/checksum/URL are overridable for air-gapped or
// mirrored installs (point WORDPRESS_WP_CLI_URL at an internal artifact store).
const WP_CLI_VERSION = process.env.WORDPRESS_WP_CLI_VERSION || "2.11.0";
const WP_CLI_SHA256 =
  process.env.WORDPRESS_WP_CLI_SHA256 || "a39021ac809530ea607580dbf93afbc46ba02f86b6cffd03de4b126ca53079f6";
const WP_CLI_URL =
  process.env.WORDPRESS_WP_CLI_URL ||
  `https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar`;
const WP_CLI_DIR = "/wp-cli";
// PATH for the WordPress container: prepend the shared wp-cli dir, then the stock
// image PATH so the entrypoint (apache2-foreground, php, docker-entrypoint.sh)
// keeps working unchanged.
const WP_CLI_PATH = `${WP_CLI_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
// Download + verify + make executable. Fails the pod (init container error) if the
// checksum doesn't match, so a tampered/truncated phar never reaches the site.
const WP_CLI_INSTALL = [
  "set -e",
  `curl -fsSL -o ${WP_CLI_DIR}/wp "$WP_CLI_URL"`,
  `echo "$WP_CLI_SHA256  ${WP_CLI_DIR}/wp" | sha256sum -c -`,
  `chmod +x ${WP_CLI_DIR}/wp`,
].join("\n");

export interface ContainerResources {
  requests?: { cpu?: string; memory?: string };
  limits?: { cpu?: string; memory?: string };
}

/**
 * How Authentik fronts the site:
 *  - "none"  — fully public, no auth.
 *  - "admin" — public site, but /wp-admin + /wp-login.php go through Authentik
 *              forward-auth (with WP OIDC auto-login), and high-risk surface
 *              (xmlrpc, REST user enumeration, sensitive files) is blocked.
 *  - "full"  — the entire site sits behind Authentik forward-auth.
 */
export type AuthMode = "none" | "admin" | "full";

export interface SiteManifestOptions {
  wpImage?: string;
  dbImage?: string;
  wpStorage?: string;
  dbStorage?: string;
  storageClass?: string;
  /** The fully-resolved public host (e.g. `blog.int.rlservers.com`). */
  host?: string;
  /** Authentik fronting mode; defaults to "none". */
  authMode?: AuthMode;
  /** Placement, persisted as labels so listings can recompute the host. */
  domain?: string;
  internal?: boolean;
  subdomain?: string;
  /** ClusterIssuer / certResolver name for TLS; omit for Traefik default cert. */
  certIssuer?: string;
  /** Per-container resource requests/limits; sensible defaults applied otherwise. */
  wpResources?: ContainerResources;
  dbResources?: ContainerResources;
}

// No CPU limit by default — CPU throttling hurts PHP/MariaDB latency far more than
// a memory cap, which is the actual node-stability guardrail we care about.
const DEFAULT_WP_RESOURCES: ContainerResources = {
  requests: { cpu: "100m", memory: "256Mi" },
  limits: { memory: "512Mi" },
};
const DEFAULT_DB_RESOURCES: ContainerResources = {
  requests: { cpu: "100m", memory: "256Mi" },
  limits: { memory: "768Mi" },
};

// Every object the addon creates carries these so it owns a clean, selectable
// slice of the namespace and nothing else.
export function siteLabels(site: string): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "infraweaver",
    "infraweaver/wordpress": "true",
    "infraweaver.io/site": site,
  };
}

// Labels for a workload of a given component (wordpress|db). Carried on the
// Deployment metadata *and* the pod template so list/selector queries that filter
// on `infraweaver.io/component` match the Deployment object, not just its pods.
export function componentLabels(site: string, component: "wordpress" | "db"): Record<string, string> {
  return { ...siteLabels(site), "infraweaver.io/component": component };
}

// Placement labels carried on the WordPress Deployment metadata so listings can
// recompute the public host (subdomain + internal + domain) and surface the auth
// mode without re-reading the vault. Domain/subdomain are DNS-safe label values.
export function placementLabels(opts: SiteManifestOptions): Record<string, string> {
  const labels: Record<string, string> = { "infraweaver.io/internal": opts.internal ? "true" : "false" };
  if (opts.domain) labels["infraweaver.io/domain"] = opts.domain;
  if (opts.subdomain) labels["infraweaver.io/subdomain"] = opts.subdomain;
  if (opts.authMode) labels["infraweaver.io/auth-mode"] = opts.authMode;
  return labels;
}

function pvc(name: string, site: string, size: string, storageClass: string) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, namespace: WORDPRESS_NAMESPACE, labels: siteLabels(site) },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: storageClass,
      resources: { requests: { storage: size } },
    },
  };
}

function service(name: string, site: string, component: "wordpress" | "db", port: number, targetPort: number) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: WORDPRESS_NAMESPACE, labels: siteLabels(site) },
    spec: {
      // Component is passed explicitly, not inferred from the name suffix — a site
      // legitimately named e.g. "my-db" must not make the WP service select db pods.
      selector: { "infraweaver.io/site": site, "infraweaver.io/component": component },
      ports: [{ port, targetPort, protocol: "TCP" }],
    },
  };
}

const HARDENED_CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  runAsNonRoot: true,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

// `MYSQL_PWD` is read from the env, so the root password never appears as a
// process argument in /proc/<pid>/cmdline the way `-p<secret>` would.
const DB_PING = "MYSQL_PWD=$MARIADB_ROOT_PASSWORD mariadb-admin ping -h 127.0.0.1 -u root";

export function buildDbManifests(site: string, opts: SiteManifestOptions = {}) {
  const names = resourceNames(site);
  const storageClass = opts.storageClass || STORAGE_CLASS;
  const labels = componentLabels(site, "db");
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: names.db, namespace: WORDPRESS_NAMESPACE, labels },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { "infraweaver.io/site": site, "infraweaver.io/component": "db" } },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { runAsNonRoot: true, fsGroup: 999, runAsUser: 999 },
          containers: [
            {
              name: "mariadb",
              image: opts.dbImage || DEFAULT_DB_IMAGE,
              securityContext: { ...HARDENED_CONTAINER_SECURITY, runAsUser: 999 },
              env: [
                envFromSecret("MARIADB_ROOT_PASSWORD", names.dbSecret, "rootPassword"),
                envFromSecret("MARIADB_DATABASE", names.dbSecret, "database"),
                envFromSecret("MARIADB_USER", names.dbSecret, "user"),
                envFromSecret("MARIADB_PASSWORD", names.dbSecret, "password"),
              ],
              ports: [{ containerPort: 3306 }],
              resources: opts.dbResources || DEFAULT_DB_RESOURCES,
              volumeMounts: [{ name: "data", mountPath: "/var/lib/mysql" }],
              readinessProbe: { exec: { command: ["sh", "-c", DB_PING] }, initialDelaySeconds: 10, periodSeconds: 10 },
              livenessProbe: { exec: { command: ["sh", "-c", DB_PING] }, initialDelaySeconds: 30, periodSeconds: 20, failureThreshold: 3 },
            },
          ],
          volumes: [{ name: "data", persistentVolumeClaim: { claimName: names.dbPvc } }],
        },
      },
    },
  };
  return {
    pvc: pvc(names.dbPvc, site, opts.dbStorage || "5Gi", storageClass),
    deployment,
    service: service(names.dbService, site, "db", 3306, 3306),
    networkPolicy: buildDbNetworkPolicy(site),
  };
}

/**
 * Restrict ingress to the site's MariaDB to only the site's own WordPress pods.
 * Without this the DB port is reachable by every pod in the cluster; this scopes
 * the attack surface to the one workload that legitimately needs the database.
 */
export function buildDbNetworkPolicy(site: string) {
  const names = resourceNames(site);
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: `${names.db}-allow-wp`, namespace: WORDPRESS_NAMESPACE, labels: siteLabels(site) },
    spec: {
      podSelector: { matchLabels: { "infraweaver.io/site": site, "infraweaver.io/component": "db" } },
      policyTypes: ["Ingress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { "infraweaver.io/site": site, "infraweaver.io/component": "wordpress" } } }],
          ports: [{ protocol: "TCP", port: 3306 }],
        },
      ],
    },
  };
}

export function buildWpManifests(site: string, opts: SiteManifestOptions = {}) {
  const names = resourceNames(site);
  const storageClass = opts.storageClass || STORAGE_CLASS;
  const labels = componentLabels(site, "wordpress");
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: names.wp, namespace: WORDPRESS_NAMESPACE, labels: { ...labels, ...placementLabels(opts) } },
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: { "infraweaver.io/site": site, "infraweaver.io/component": "wordpress" } },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { runAsNonRoot: true, fsGroup: 33, runAsUser: 33 },
          // Stage a pinned, checksum-verified wp-cli into a shared volume so the
          // WordPress container can run `wp` (the official image bundles none).
          initContainers: [
            {
              name: "wp-cli",
              image: opts.wpImage || DEFAULT_WP_IMAGE,
              securityContext: { ...HARDENED_CONTAINER_SECURITY, runAsUser: 33 },
              command: ["sh", "-c", WP_CLI_INSTALL],
              env: [
                { name: "WP_CLI_URL", value: WP_CLI_URL },
                { name: "WP_CLI_SHA256", value: WP_CLI_SHA256 },
              ],
              resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: "128Mi" } },
              volumeMounts: [{ name: "wp-cli", mountPath: WP_CLI_DIR }],
            },
          ],
          containers: [
            {
              name: "wordpress",
              image: opts.wpImage || DEFAULT_WP_IMAGE,
              securityContext: { ...HARDENED_CONTAINER_SECURITY, runAsUser: 33 },
              env: [
                // Put the staged wp-cli on PATH so `sh -c "wp …"` execs resolve it.
                { name: "PATH", value: WP_CLI_PATH },
                { name: "WORDPRESS_DB_HOST", value: names.dbService },
                envFromSecret("WORDPRESS_DB_NAME", names.dbSecret, "database"),
                envFromSecret("WORDPRESS_DB_USER", names.dbSecret, "user"),
                envFromSecret("WORDPRESS_DB_PASSWORD", names.dbSecret, "password"),
                envFromSecret("WORDPRESS_AUTH_KEY", names.wpSecret, "AUTH_KEY"),
                envFromSecret("WORDPRESS_SECURE_AUTH_KEY", names.wpSecret, "SECURE_AUTH_KEY"),
                envFromSecret("WORDPRESS_LOGGED_IN_KEY", names.wpSecret, "LOGGED_IN_KEY"),
                envFromSecret("WORDPRESS_NONCE_KEY", names.wpSecret, "NONCE_KEY"),
                envFromSecret("WORDPRESS_AUTH_SALT", names.wpSecret, "AUTH_SALT"),
                envFromSecret("WORDPRESS_SECURE_AUTH_SALT", names.wpSecret, "SECURE_AUTH_SALT"),
                envFromSecret("WORDPRESS_LOGGED_IN_SALT", names.wpSecret, "LOGGED_IN_SALT"),
                envFromSecret("WORDPRESS_NONCE_SALT", names.wpSecret, "NONCE_SALT"),
              ],
              ports: [{ containerPort: 80 }],
              resources: opts.wpResources || DEFAULT_WP_RESOURCES,
              volumeMounts: [
                { name: "data", mountPath: "/var/www/html" },
                { name: "wp-cli", mountPath: WP_CLI_DIR, readOnly: true },
              ],
              // TCP probes, not httpGet: once SSO is enabled the OIDC plugin's
              // login_type=auto turns /wp-login.php (and /wp-admin) into a redirect
              // into the Authentik flow, which an httpGet probe follows into a
              // redirect loop and fails — crash-looping an otherwise healthy site.
              // A TCP check on 80 confirms Apache is serving without tripping auth.
              readinessProbe: { tcpSocket: { port: 80 }, initialDelaySeconds: 20, periodSeconds: 10 },
              // Longer delay than readiness: WordPress cold-starts slowly, and we
              // only want a restart once it's genuinely wedged, not merely slow.
              livenessProbe: { tcpSocket: { port: 80 }, initialDelaySeconds: 60, periodSeconds: 20, failureThreshold: 3 },
            },
          ],
          volumes: [
            { name: "data", persistentVolumeClaim: { claimName: names.wpPvc } },
            { name: "wp-cli", emptyDir: {} },
          ],
        },
      },
    },
  };
  return {
    pvc: pvc(names.wpPvc, site, opts.wpStorage || "5Gi", storageClass),
    deployment,
    service: service(names.wpService, site, "wordpress", 80, 80),
  };
}

function envFromSecret(name: string, secretName: string, key: string) {
  return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
}

/** Shared, namespace-scoped middleware name that denies all traffic (→ 403). */
const DENY_MIDDLEWARE = "wordpress-deny";

/**
 * A Traefik middleware that denies every request — an ipAllowList scoped to a
 * single non-routable address, so any real client falls outside it and gets a
 * 403. Used to hard-block high-risk WordPress paths. One per namespace, shared by
 * every site; applying it is idempotent.
 */
export function buildDenyMiddleware() {
  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "Middleware",
    metadata: { name: DENY_MIDDLEWARE, namespace: WORDPRESS_NAMESPACE, labels: { "app.kubernetes.io/managed-by": "infraweaver" } },
    spec: { ipAllowList: { sourceRange: ["255.255.255.255/32"] } },
  };
}

type MiddlewareRef = { name: string; namespace?: string };

// In "admin" mode: gate /wp-admin + /wp-login.php behind Authentik (admin-ajax.php
// stays public — themes/plugins call it unauthenticated), and 403 the high-risk
// surface (XML-RPC, REST user enumeration, sensitive dotfiles).
const AJAX_MATCH = "Path(`/wp-admin/admin-ajax.php`)";
const ADMIN_MATCH = "(PathPrefix(`/wp-admin`) || Path(`/wp-login.php`))";
const BLOCK_MATCH =
  "(Path(`/xmlrpc.php`) || PathPrefix(`/wp-json/wp/v2/users`) || Path(`/wp-config.php`) || Path(`/readme.html`) || Path(`/license.txt`) || Path(`/wp-content/debug.log`))";

/** A Traefik IngressRoute (traefik.io/v1alpha1) for the site, TLS-terminated. */
export function buildIngressRoute(site: string, opts: SiteManifestOptions = {}) {
  const names = resourceNames(site);
  const host = opts.host || legacySiteHost(site);
  const certResolver = opts.certIssuer || configCertIssuer();
  const authMode = opts.authMode ?? "none";
  const fwdAuth = forwardAuthMiddleware();
  const SECURE_HEADERS = secureHeadersMiddleware();
  const deny: MiddlewareRef = { name: DENY_MIDDLEWARE, namespace: WORDPRESS_NAMESPACE };
  const services = [{ name: names.wpService, port: 80 }];

  // Higher Traefik priority = evaluated first, so the specific public/blocked
  // rules win over the gated and catch-all rules.
  const rule = (match: string, middlewares: MiddlewareRef[], priority?: number) => ({
    match: match ? `Host(\`${host}\`) && ${match}` : `Host(\`${host}\`)`,
    kind: "Rule" as const,
    ...(priority !== undefined ? { priority } : {}),
    middlewares,
    services,
  });

  let routes;
  if (authMode === "full") {
    routes = [rule("", [SECURE_HEADERS, fwdAuth])];
  } else if (authMode === "admin") {
    routes = [
      rule(AJAX_MATCH, [SECURE_HEADERS], 100),
      rule(BLOCK_MATCH, [SECURE_HEADERS, deny], 90),
      rule(ADMIN_MATCH, [SECURE_HEADERS, fwdAuth], 80),
      rule("", [SECURE_HEADERS], 10),
    ];
  } else {
    routes = [rule("", [SECURE_HEADERS])];
  }

  return {
    apiVersion: "traefik.io/v1alpha1",
    kind: "IngressRoute",
    metadata: { name: names.ingressRoute, namespace: WORDPRESS_NAMESPACE, labels: siteLabels(site) },
    spec: {
      entryPoints: ["websecure"],
      routes,
      tls: certResolver ? { certResolver } : {},
    },
  };
}

/** The complete object set for a site, ready to apply in dependency order. */
export function buildSiteManifests(site: string, opts: SiteManifestOptions = {}) {
  const db = buildDbManifests(site, opts);
  const wp = buildWpManifests(site, opts);
  const ingressRoute = buildIngressRoute(site, opts);
  const host = opts.host || legacySiteHost(site);
  // The deny middleware is only referenced by "admin" mode; create it only then.
  const denyMiddleware = (opts.authMode ?? "none") === "admin" ? [buildDenyMiddleware()] : [];
  return {
    host,
    // Apply order: storage, then DB (+ its network policy), then WordPress, then
    // the edge middleware + IngressRoute.
    objects: [db.pvc, db.networkPolicy, db.service, db.deployment, wp.pvc, wp.service, wp.deployment, ...denyMiddleware, ingressRoute],
    db,
    wp,
    ingressRoute,
  };
}
