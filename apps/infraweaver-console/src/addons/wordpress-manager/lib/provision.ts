import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "@/lib/k8s";
import { upsertCnameRecord, deleteRecordsByName, resolveZoneId } from "@/lib/cloudflare";
import { WORDPRESS_NAMESPACE } from "./wordpress-rbac";
import { assertValidSiteName, assertValidSiteId, resourceNames, deriveSiteId, buildHost, legacySiteHost } from "./naming";
import { isAllowedDomain, publicCnameTarget, publicDnsProxied, authentikIssuerBase, adminUser, adminEmail } from "./config";
import { isInstalledScript, coreInstallScript } from "./core-install";
import { generateSiteSecrets, vaultData, vaultPaths } from "./secrets";
import { buildSiteManifests, siteLabels, type SiteManifestOptions, type AuthMode } from "./manifest";
import { writeSecret, readSecret, deleteSecret } from "./openbao";
import { buildPluginSyncPlan, listPluginsCommand, installPluginCommand, removePluginCommand, AUTHENTIK_PLUGIN_SLUG } from "./plugins";
import { redirectUri, buildOidcSettings, pluginInstallCommand, optionUpdateFromStdinCommand, OIDC_SETTINGS_OPTION } from "./authentik";
import { ensureSsoGate, removeSsoGate } from "@/lib/sso/sso-gate";
import { execInWpPod } from "./k8s-exec";
import { isK8sNotFound } from "./k8s-errors";
import { ServiceUnavailableError, SiteNotFoundError } from "./errors";

export interface SiteSummary {
  site: string;
  host: string;
  ready: boolean;
  replicas: number;
  domain?: string;
  internal?: boolean;
  authMode?: AuthMode;
  /** True when plugins/SSO are still being applied in the background. */
  setupPending?: boolean;
  /** Set when DNS wiring failed; the site is up but may not resolve yet. */
  dnsWarning?: string;
}

/** Site placement + post-provision setup intent, as supplied by the create form. */
export interface CreateSiteInput {
  name: string;
  domain: string;
  internal: boolean;
  authMode: AuthMode;
  plugins?: string[];
  wpStorage?: string;
  dbStorage?: string;
}

type SecretData = { db: Record<string, string>; wp: Record<string, string> };

function clients() {
  const kc = loadKubeConfig();
  return {
    kc,
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    objects: k8s.KubernetesObjectApi.makeApiClient(kc),
  };
}

/**
 * Create or replace one object so re-provisioning converges instead of
 * conflicting. Only a genuine 404 (object absent) falls through to create — any
 * other error (403, 409, network) propagates rather than being masked by a
 * misleading "already exists" from a blind create.
 */
async function applyObject(objects: k8s.KubernetesObjectApi, body: k8s.KubernetesObject): Promise<void> {
  let resourceVersion: string | undefined;
  try {
    const existing = await objects.read(body as Parameters<typeof objects.read>[0]);
    resourceVersion = (existing as k8s.KubernetesObject).metadata?.resourceVersion;
  } catch (err) {
    if (!isK8sNotFound(err)) throw err;
    await objects.create(body);
    return;
  }
  await objects.replace({ ...body, metadata: { ...body.metadata, resourceVersion } });
}

/** Project a site's secrets into the two k8s Secrets the pods read. */
async function applySecrets(core: k8s.CoreV1Api, site: string, data: SecretData): Promise<void> {
  const names = resourceNames(site);
  for (const [name, stringData] of [
    [names.dbSecret, data.db],
    [names.wpSecret, data.wp],
  ] as const) {
    const secret: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name, namespace: WORDPRESS_NAMESPACE, labels: siteLabels(site) },
      stringData,
    };
    try {
      await core.replaceNamespacedSecret({ name, namespace: WORDPRESS_NAMESPACE, body: secret });
    } catch (err) {
      if (!isK8sNotFound(err)) throw err;
      await core.createNamespacedSecret({ namespace: WORDPRESS_NAMESPACE, body: secret });
    }
  }
}

/** Persist the desired post-provision setup (plugins + auth mode) to the vault. */
async function writeIntent(site: string, authMode: AuthMode, plugins: string[], applied: boolean): Promise<void> {
  await writeSecret(vaultPaths(site).config, { authMode, plugins: plugins.join(","), applied: applied ? "true" : "false" });
}

async function readIntent(site: string): Promise<{ authMode: AuthMode; plugins: string[]; applied: boolean } | null> {
  const cfg = await readSecret(vaultPaths(site).config);
  if (!cfg) return null;
  return {
    authMode: (cfg.authMode as AuthMode) || "none",
    plugins: (cfg.plugins || "").split(",").map((s) => s.trim()).filter(Boolean),
    applied: cfg.applied === "true",
  };
}

/**
 * Provision a new WordPress site end to end: validate placement, generate and
 * persist secrets, apply the workloads, wire DNS, and record the desired plugins/
 * SSO so a background finalizer applies them once the pod is running. Idempotent.
 */
export async function createSite(input: CreateSiteInput): Promise<SiteSummary> {
  const name = input.name.trim().toLowerCase();
  const domain = input.domain.trim().toLowerCase();
  const internal = !!input.internal;
  const authMode: AuthMode = input.authMode ?? "none";
  if (!(await isAllowedDomain(domain))) throw new Error(`Domain "${domain}" is not configured`);
  if (name) assertValidSiteName(name);
  const site = assertValidSiteId(deriveSiteId(name, domain));
  const host = buildHost({ name, domain, internal });

  const { core, objects } = clients();
  const paths = vaultPaths(site);

  // Idempotency, with the two vault paths treated independently. The DB password
  // is baked into MariaDB's initialised data dir and can NEVER be regenerated for
  // a live site, so the DB secret's existence is the authoritative "already
  // exists" marker; we only generate what is genuinely missing.
  const existingDb = await readSecret(paths.db);
  const existingWp = await readSecret(paths.wp);
  let data: SecretData;
  if (existingDb) {
    const wp = existingWp ?? vaultData(generateSiteSecrets(site)).wp;
    if (!existingWp) await writeSecret(paths.wp, wp);
    data = { db: existingDb, wp };
  } else {
    data = vaultData(generateSiteSecrets(site));
    await writeSecret(paths.db, data.db);
    await writeSecret(paths.wp, data.wp);
  }
  await applySecrets(core, site, data);

  const manifestOpts: SiteManifestOptions = {
    host,
    authMode,
    domain,
    internal,
    subdomain: name,
    wpStorage: input.wpStorage,
    dbStorage: input.dbStorage,
  };
  const { objects: manifestObjects } = buildSiteManifests(site, manifestOpts);
  for (const obj of manifestObjects) {
    await applyObject(objects, obj as k8s.KubernetesObject);
  }

  // Wire public DNS only for a public *subdomain*: a root-domain site already has
  // its apex record, and internal sites are served by the internal resolver. The
  // CNAME target defaults to the site's own root domain (which the operator points
  // at their ingress), so no IP is ever hardcoded.
  let dnsWarning: string | undefined;
  if (!internal && name) {
    try {
      const zoneId = await resolveZoneId(domain);
      await upsertCnameRecord(host, publicCnameTarget() ?? domain, publicDnsProxied(), zoneId);
    } catch (err) {
      dnsWarning = `DNS record for ${host} could not be created: ${err instanceof Error ? err.message : "unknown error"}`;
      console.warn(`[wordpress] ${dnsWarning}`);
    }
  }

  const desiredPlugins = [...new Set(input.plugins ?? [])];
  const setupPending = authMode !== "none" || desiredPlugins.length > 0;
  await writeIntent(site, authMode, desiredPlugins, !setupPending);
  if (setupPending) triggerReconcile(site);

  return { site, host, ready: false, replicas: 1, domain, internal, authMode, setupPending, dnsWarning };
}

/** True if a site already exists, keyed on the authoritative (non-regenerable) DB secret. */
export async function siteExists(site: string): Promise<boolean> {
  return (await readSecret(vaultPaths(site).db)) !== null;
}

export async function listSites(): Promise<SiteSummary[]> {
  const { apps } = clients();
  const deployments = await apps.listNamespacedDeployment({
    namespace: WORDPRESS_NAMESPACE,
    labelSelector: "infraweaver/wordpress=true,infraweaver.io/component=wordpress",
  });
  return (deployments.items ?? []).map((dep) => {
    const labels = dep.metadata?.labels ?? {};
    const site = labels["infraweaver.io/site"] ?? dep.metadata?.name ?? "";
    const domain = labels["infraweaver.io/domain"];
    const internal = labels["infraweaver.io/internal"] === "true";
    const subdomain = labels["infraweaver.io/subdomain"] ?? "";
    const authMode = labels["infraweaver.io/auth-mode"] as AuthMode | undefined;
    const host = domain ? buildHost({ name: subdomain, domain, internal }) : legacySiteHost(site);
    const ready = (dep.status?.readyReplicas ?? 0) > 0;
    // Every poll nudges any READY-but-unsettled site toward its recorded SSO/plugin
    // intent; the call is deduped and no-ops once the vault `applied` flag is set.
    if (ready && site) triggerReconcile(site);
    return {
      site,
      host,
      ready,
      replicas: dep.spec?.replicas ?? 0,
      domain,
      internal,
      authMode,
    };
  });
}

/** Resolve the public host for a site from its live placement labels (for teardown). */
async function siteHostFromCluster(apps: k8s.AppsV1Api, site: string): Promise<string> {
  try {
    const dep = await apps.readNamespacedDeployment({ name: site, namespace: WORDPRESS_NAMESPACE });
    const labels = dep.metadata?.labels ?? {};
    const domain = labels["infraweaver.io/domain"];
    if (domain) {
      return buildHost({ name: labels["infraweaver.io/subdomain"] ?? "", domain, internal: labels["infraweaver.io/internal"] === "true" });
    }
  } catch {
    /* fall through to legacy host */
  }
  return legacySiteHost(site);
}

export async function deleteSite(site: string): Promise<void> {
  assertValidSiteId(site);
  const { core, apps, objects } = clients();
  const names = resourceNames(site);
  const opts = { namespace: WORDPRESS_NAMESPACE };
  const host = await siteHostFromCluster(apps, site);

  await objects
    .delete({ apiVersion: "traefik.io/v1alpha1", kind: "IngressRoute", metadata: { name: names.ingressRoute, namespace: WORDPRESS_NAMESPACE } })
    .catch(() => undefined);
  await Promise.all([
    apps.deleteNamespacedDeployment({ name: names.wp, ...opts }).catch(() => undefined),
    apps.deleteNamespacedDeployment({ name: names.db, ...opts }).catch(() => undefined),
  ]);
  await objects
    .delete({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: `${names.db}-allow-wp`, namespace: WORDPRESS_NAMESPACE } })
    .catch(() => undefined);
  await Promise.all([
    ...[names.wpService, names.dbService].map((svc) => core.deleteNamespacedService({ name: svc, ...opts }).catch(() => undefined)),
    ...[names.wpPvc, names.dbPvc].map((pvcName) => core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, ...opts }).catch(() => undefined)),
    ...[names.wpSecret, names.dbSecret].map((secretName) =>
      core.deleteNamespacedSecret({ name: secretName, ...opts }).catch((err) => {
        if (!isK8sNotFound(err)) console.warn(`[wordpress] failed to delete k8s Secret ${secretName}; credentials may remain:`, err instanceof Error ? err.message : err);
      }),
    ),
  ]);
  await resolveZoneId(host)
    .then((zoneId) => deleteRecordsByName(host, zoneId))
    .catch(() => undefined);
  // De-register the Authentik application/providers and drop the proxy provider
  // from the embedded outpost so a deleted host doesn't linger as a stale gate.
  await removeSsoGate(`wordpress-${site}`, host).catch((err) =>
    console.warn(`[wordpress] failed to remove Authentik SSO for ${site}; it may linger:`, err instanceof Error ? err.message : err),
  );
  const paths = vaultPaths(site);
  for (const path of [paths.db, paths.wp, paths.authentik, paths.config]) {
    await deleteSecret(path).catch((err) =>
      console.warn(`[wordpress] failed to delete vault secret ${path}; credentials may remain:`, err instanceof Error ? err.message : err),
    );
  }
}

/**
 * The WordPress pod name for a site (prefers a Running pod), or null if none
 * exists yet. Safe/non-throwing — used to deep-link a site to its pod page.
 */
export async function findWpPodName(site: string): Promise<string | null> {
  const { core } = clients();
  try {
    const pods = await core.listNamespacedPod({
      namespace: WORDPRESS_NAMESPACE,
      labelSelector: `infraweaver.io/site=${site},infraweaver.io/component=wordpress`,
    });
    const items = pods.items ?? [];
    const pod = items.find((p) => p.status?.phase === "Running") ?? items[0];
    return pod?.metadata?.name ?? null;
  } catch {
    return null;
  }
}

async function runningWpPod(core: k8s.CoreV1Api, site: string): Promise<string> {
  const pods = await core.listNamespacedPod({
    namespace: WORDPRESS_NAMESPACE,
    labelSelector: `infraweaver.io/site=${site},infraweaver.io/component=wordpress`,
  });
  const pod = (pods.items ?? []).find((p) => p.status?.phase === "Running");
  if (!pod?.metadata?.name) throw new ServiceUnavailableError("WordPress pod is not running yet");
  return pod.metadata.name;
}

export async function listInstalledPlugins(site: string): Promise<string[]> {
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const { stdout } = await execInWpPod(pod, listPluginsCommand());
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Converge the site's plugins onto `desired`, returning what changed (intent, not
 * the raw wp-cli strings — the caller has no business seeing the exec internals).
 */
export async function setPlugins(site: string, desired: string[]): Promise<{ installed: string[]; removed: string[] }> {
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const installed = await listInstalledPlugins(site);
  const plan = buildPluginSyncPlan(desired, installed);
  for (const slug of plan.toInstall) {
    await execInWpPod(pod, installPluginCommand(slug));
  }
  for (const slug of plan.toRemove) {
    await execInWpPod(pod, removePluginCommand(slug));
  }
  return { installed: plan.toInstall, removed: plan.toRemove };
}

/** Adapter so the generic SSO module persists the client secret via the addon's vault. */
const vaultStore = { read: readSecret, write: writeSecret };

/**
 * Enable Authentik SSO for a WordPress site via the reusable `ensureSsoGate`
 * capability: edge gate (proxy provider on the embedded outpost) + OIDC client,
 * sharing one Authentik application. Both `admin` and `full` auth modes attach the
 * Traefik forward-auth middleware, so both need the proxy provider registered or
 * forward-auth 404s — hence mode `both`. The returned OIDC endpoints are written
 * straight into the WordPress plugin (secret over stdin, never on the CLI).
 */
export async function enableSso(site: string, opts: { issuerBase: string }): Promise<void> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { core, apps } = clients();
  const host = await siteHostFromCluster(apps, site);

  const result = await ensureSsoGate(
    {
      host,
      appSlug: `wordpress-${site}`,
      appName: `WordPress — ${site}`,
      mode: "both",
      redirectUris: [redirectUri(host)],
      launchUrl: `https://${host}/wp-admin/`,
      secretPath: vaultPaths(site).authentik,
      issuerBase: opts.issuerBase,
    },
    vaultStore,
  );
  if (!result.oidc) throw new ServiceUnavailableError("Authentik did not return OIDC credentials");

  const pod = await runningWpPod(core, site);
  await execInWpPod(pod, pluginInstallCommand());
  await execInWpPod(pod, optionUpdateFromStdinCommand(OIDC_SETTINGS_OPTION), { stdin: JSON.stringify(buildOidcSettings(result.oidc)) });
}

/**
 * Install WordPress core once, idempotently. The official image leaves a fresh
 * site at the setup wizard — until core is installed there is no admin account and
 * `wp plugin`/`wp option` (and thus OIDC auto-login) can't be configured. The admin
 * password is generated at create time and lives in the vault; it is piped over
 * stdin so it never reaches the k8s exec audit log. SSO is the real login path, so
 * the local admin (its email matched to the operator's Authentik email) is linked
 * into on first SSO login rather than used directly.
 */
export async function ensureCoreInstalled(site: string, host: string, domain?: string): Promise<void> {
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const url = `https://${host}`;
  const { stdout } = await execInWpPod(pod, isInstalledScript(url));
  if (stdout.includes("INSTALLED")) return;

  const wp = await readSecret(vaultPaths(site).wp);
  const password = wp?.adminPassword;
  if (!password) throw new ServiceUnavailableError("WordPress admin password is not provisioned yet");
  await execInWpPod(
    pod,
    coreInstallScript({ url, title: site, adminUser: adminUser(), adminEmail: adminEmail(domain) }),
    { stdin: password },
  );
}

/**
 * Apply the recorded setup intent (core install + plugins + Authentik SSO) once
 * the WordPress pod is running. Idempotent; throws ServiceUnavailableError while
 * the pod is not yet ready so the finalizer can retry.
 */
export async function reconcileSite(site: string): Promise<void> {
  const intent = await readIntent(site);
  if (!intent || intent.applied) return;
  const { core, apps } = clients();
  await runningWpPod(core, site); // throws ServiceUnavailable until ready

  // Core must be installed before any wp-cli config (plugins/OIDC) can apply.
  const host = await siteHostFromCluster(apps, site);
  const domain = (await apps.readNamespacedDeployment({ name: site, namespace: WORDPRESS_NAMESPACE })
    .then((d) => d.metadata?.labels?.["infraweaver.io/domain"])
    .catch(() => undefined));
  await ensureCoreInstalled(site, host, domain);

  const wantSso = intent.authMode !== "none";
  const desired = [...new Set([...intent.plugins, ...(wantSso ? [AUTHENTIK_PLUGIN_SLUG] : [])])];
  if (desired.length > 0) await setPlugins(site, desired);

  if (wantSso) {
    const issuerBase = authentikIssuerBase();
    if (issuerBase) {
      await enableSso(site, { issuerBase });
    } else {
      console.warn(`[wordpress] SSO requested for ${site} but no Authentik issuer configured (WORDPRESS_AUTHENTIK_ISSUER); skipping`);
    }
  }
  await writeIntent(site, intent.authMode, intent.plugins, true);
}

const reconcileInFlight = new Set<string>();
const settled = new Set<string>();

/**
 * Poll-driven reconcile: fire-and-forget a single idempotent `reconcileSite` pass,
 * deduped per site. Driven by `listSites` (every dashboard poll) and by
 * `createSite`, so a new site converges on whichever replica serves the next poll
 * and the work survives a restart — the vault `applied` flag is the durable record,
 * and the `settled` set short-circuits already-applied sites without a vault read.
 * While the pod is not ready, `reconcileSite` throws ServiceUnavailable and we
 * simply retry on the next poll.
 */
export function triggerReconcile(site: string): void {
  if (settled.has(site) || reconcileInFlight.has(site)) return;
  reconcileInFlight.add(site);
  void reconcileSite(site)
    .then(() => settled.add(site))
    .catch((err) => {
      if (!(err instanceof ServiceUnavailableError)) {
        console.warn(`[wordpress] reconcile for ${site} failed:`, err instanceof Error ? err.message : err);
      }
    })
    .finally(() => reconcileInFlight.delete(site));
}
