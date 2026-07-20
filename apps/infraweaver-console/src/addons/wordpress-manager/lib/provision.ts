import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "@/lib/k8s";
import { upsertCnameRecord, deleteRecordsByName, resolveZoneId } from "@/lib/cloudflare";
import { WORDPRESS_NAMESPACE } from "./wordpress-rbac";
import { assertValidSiteName, assertValidSiteId, resourceNames, deriveSiteId, buildHost, legacySiteHost } from "./naming";
import { isAllowedDomain, publicCnameTarget, publicDnsProxied, authentikIssuerBase, adminUser, adminEmail } from "./config";
import { isInstalledScript, coreInstallScript } from "./core-install";
import { generateSiteSecrets, vaultData, vaultPaths } from "./secrets";
import { buildSiteManifests, buildIngressRoute, buildDenyMiddleware, isGatedAuthMode, siteLabels, type SiteManifestOptions, type AuthMode } from "./manifest";
import { writeSecret, readSecret, deleteSecret } from "./openbao";
import { buildPluginSyncPlan, listPluginsCommand, installPluginCommand, removePluginCommand, updateAllPluginsCommand, parsePluginUpdateResult, AUTHENTIK_PLUGIN_SLUG, type PluginUpdateResult } from "./plugins";
import { installMaintenancePluginCommand, maintenancePluginContents, setMaintenanceCommand, maintenanceStatusCommand, parseMaintenanceStatus, type MaintenanceStatus } from "./maintenance";
import { redirectUri, buildOidcSettings, pluginInstallCommand, optionUpdateFromStdinCommand, OIDC_SETTINGS_OPTION } from "./authentik";
import { ensureSsoGate, removeSsoGate } from "@/lib/sso/sso-gate";
import { ensureSiteAccess, removeSiteAccess } from "./access";
import { loadUsersConfig } from "@/lib/users-config";
import { computeSiteWordpressUsers } from "./access-policy";
import { applyWpUserSyncPlan, buildWpUserSyncPlan, listWpUsersCommand, parseWpUserList, type WpUserSyncAction, type WpUserSyncFailure } from "./wp-users";
import { execInWpPod } from "./k8s-exec";
import { isK8sNotFound } from "./k8s-errors";
import { ServiceUnavailableError, SiteNotFoundError } from "./errors";
import { SsoUnavailableError } from "@/lib/sso/errors";
import { emitSsoUnavailableAlert, clearSsoUnavailableAlert } from "./reconcile-alerts";
import { siteHealthCommand, parseSiteHealth, type SiteHealth } from "./health";
import { shapeSitePods, type SitePod, type SitePodSource } from "./site-pods";
import { runStep, type StepOutcome, type TeardownStep } from "./teardown-step";

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
  /** §5.1 — install + enroll the InfraWeaver Connector once running (default true). */
  connector?: boolean;
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
async function writeIntent(site: string, authMode: AuthMode, plugins: string[], connector: boolean, applied: boolean): Promise<void> {
  await writeSecret(vaultPaths(site).config, {
    authMode,
    plugins: plugins.join(","),
    connector: connector ? "true" : "false",
    applied: applied ? "true" : "false",
  });
}

async function readIntent(site: string): Promise<{ authMode: AuthMode; plugins: string[]; connector: boolean; applied: boolean } | null> {
  const cfg = await readSecret(vaultPaths(site).config);
  if (!cfg) return null;
  return {
    authMode: (cfg.authMode as AuthMode) || "none",
    plugins: (cfg.plugins || "").split(",").map((s) => s.trim()).filter(Boolean),
    // Absent on pre-connector sites → false: existing sites never get a
    // surprise enrollment; the site-settings card is the opt-in for those.
    connector: cfg.connector === "true",
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
  const connector = input.connector ?? true; // §5.1 — default ON for IW-provisioned sites
  const setupPending = authMode !== "none" || desiredPlugins.length > 0 || connector;
  await writeIntent(site, authMode, desiredPlugins, connector, !setupPending);
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

/**
 * Delete a k8s resource, classifying an already-absent (404) object as a
 * `skipped` idempotent no-op rather than a failure. Any other error rethrows so
 * `runStep` records it as `failed` — the teardown keeps going regardless.
 */
async function k8sDelete(del: () => Promise<unknown>): Promise<StepOutcome> {
  try {
    await del();
    return { status: "removed" };
  } catch (err) {
    if (isK8sNotFound(err)) return { status: "skipped", detail: "already absent" };
    throw err;
  }
}

/**
 * Tear down every cluster/DNS/secret resource a site owns (§12.6 delete steps
 * b–e, plus the Authentik gate and access group that make up the console
 * record). Idempotent and partial-failure-tolerant: each resource is its own
 * tracked step, an already-absent object is `skipped`, and one failing delete
 * never aborts the rest — the caller aggregates the returned steps and can
 * safely re-run the whole teardown to finish any that failed. Callers that also
 * need the signed connector purge (step a) and link-record removal (step f)
 * should use `teardownSite`, which wraps this.
 */
export async function deleteSite(site: string): Promise<TeardownStep[]> {
  assertValidSiteId(site);
  const { core, apps, objects } = clients();
  const names = resourceNames(site);
  const opts = { namespace: WORDPRESS_NAMESPACE };
  const host = await siteHostFromCluster(apps, site);
  const steps: TeardownStep[] = [];

  // (b) Deployments + Services (and the ingress route / db network policy).
  steps.push(
    await runStep(`ingressroute/${names.ingressRoute}`, () =>
      k8sDelete(() =>
        objects.delete({ apiVersion: "traefik.io/v1alpha1", kind: "IngressRoute", metadata: { name: names.ingressRoute, namespace: WORDPRESS_NAMESPACE } }),
      ),
    ),
  );
  steps.push(await runStep(`deployment/${names.wp}`, () => k8sDelete(() => apps.deleteNamespacedDeployment({ name: names.wp, ...opts }))));
  steps.push(await runStep(`deployment/${names.db}`, () => k8sDelete(() => apps.deleteNamespacedDeployment({ name: names.db, ...opts }))));
  steps.push(
    await runStep(`networkpolicy/${names.db}-allow-wp`, () =>
      k8sDelete(() =>
        objects.delete({ apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: `${names.db}-allow-wp`, namespace: WORDPRESS_NAMESPACE } }),
      ),
    ),
  );
  for (const svc of [names.wpService, names.dbService]) {
    steps.push(await runStep(`service/${svc}`, () => k8sDelete(() => core.deleteNamespacedService({ name: svc, ...opts }))));
  }
  // (c) Storage — the PVCs. This is the irreversible data loss.
  for (const pvcName of [names.wpPvc, names.dbPvc]) {
    steps.push(await runStep(`pvc/${pvcName}`, () => k8sDelete(() => core.deleteNamespacedPersistentVolumeClaim({ name: pvcName, ...opts }))));
  }
  // In-cluster k8s Secrets the pods mount (distinct from the OpenBao paths below).
  for (const secretName of [names.wpSecret, names.dbSecret]) {
    steps.push(await runStep(`k8s-secret/${secretName}`, () => k8sDelete(() => core.deleteNamespacedSecret({ name: secretName, ...opts }))));
  }
  // (e) Public DNS record, if one was created for the host.
  steps.push(
    await runStep("dns", async () => {
      const zoneId = await resolveZoneId(host);
      await deleteRecordsByName(host, zoneId);
      return { status: "removed" };
    }),
  );
  // Console record: de-register the Authentik application/providers + drop the
  // proxy provider from the embedded outpost so a deleted host leaves no gate.
  steps.push(
    await runStep("authentik-sso", async () => {
      await removeSsoGate(`wordpress-${site}`, host);
      return { status: "removed" };
    }),
  );
  // Console record: drop the per-site access group so no stale group lingers.
  steps.push(
    await runStep("access-group", async () => {
      await removeSiteAccess(site);
      return { status: "removed" };
    }),
  );
  // (d) OpenBao secret paths — deleteSecret already treats a 404 as success.
  const paths = vaultPaths(site);
  for (const [label, path] of Object.entries({ db: paths.db, wp: paths.wp, authentik: paths.authentik, config: paths.config })) {
    steps.push(
      await runStep(`vault/${label}`, async () => {
        await deleteSecret(path);
        return { status: "removed" };
      }),
    );
  }
  return steps;
}

export interface WordpressUserSyncSummary {
  /** What the reconcile did per RBAC-granted user (created/updated/unchanged/failed). */
  actions: WpUserSyncAction[];
  /** Granted users that cannot get an account because users.yaml has no email. */
  skippedNoEmail: string[];
  /** Accounts whose create/update threw — reconcile continued past them. */
  failed: WpUserSyncFailure[];
}

/**
 * Materialize the site's RBAC grants as real WordPress accounts: everyone with
 * site access gets a user whose WordPress role mirrors their InfraWeaver role
 * (admin → administrator, write → editor, read → subscriber), so the site's
 * user list reflects who actually has access — not just the install admin.
 * Accounts of revoked users are left in place (the Authentik gate enforces
 * revocation); the install admin account is never touched. Idempotent.
 */
export async function syncSiteWpUsers(site: string): Promise<WordpressUserSyncSummary> {
  assertValidSiteId(site);
  const cfg = await loadUsersConfig();
  const desired = computeSiteWordpressUsers(site, cfg.users, cfg.groups);
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const existing = parseWpUserList((await execInWpPod(pod, listWpUsersCommand())).stdout);
  const plan = buildWpUserSyncPlan(desired.users, existing, adminUser());
  const { actions, failed } = await applyWpUserSyncPlan(plan, async (command) => {
    await execInWpPod(pod, command);
  });
  return { actions, skippedNoEmail: desired.skippedNoEmail, failed };
}

/**
 * The live pods behind one site (WordPress + MariaDB), via the per-site label
 * every pod carries. Powers the site detail's pod list + firewall panel.
 */
export async function listSitePods(site: string): Promise<SitePod[]> {
  assertValidSiteId(site);
  const { core } = clients();
  const pods = await core.listNamespacedPod({
    namespace: WORDPRESS_NAMESPACE,
    labelSelector: `infraweaver.io/site=${site}`,
  });
  return shapeSitePods((pods.items ?? []) as SitePodSource[]);
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

/**
 * Update every installed plugin to its latest version in one wp-cli pass, returning
 * the per-plugin outcome (old → new version + status). Reuses the same pod-exec path
 * as plugin install/sync; nothing to update yields an empty list, not an error.
 */
export async function updateAllPlugins(site: string): Promise<{ updated: PluginUpdateResult[] }> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const { stdout } = await execInWpPod(pod, updateAllPluginsCommand());
  return { updated: parsePluginUpdateResult(stdout) };
}

/** Read whether the InfraWeaver maintenance page is currently active for a site. */
export async function getMaintenanceMode(site: string): Promise<MaintenanceStatus> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const { stdout } = await execInWpPod(pod, maintenanceStatusCommand());
  return parseMaintenanceStatus(stdout);
}

/**
 * Turn maintenance mode on/off. Enabling first (idempotently) drops the must-use
 * plugin — streamed over stdin so the PHP lands verbatim — then flips the option so
 * the gate is always backed by the enforcing code before it's switched on.
 */
export async function setMaintenanceMode(site: string, enabled: boolean): Promise<MaintenanceStatus> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  if (enabled) {
    await execInWpPod(pod, installMaintenancePluginCommand(), { stdin: maintenancePluginContents() });
  }
  await execInWpPod(pod, setMaintenanceCommand(enabled));
  return { enabled };
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
    // Lock the gate to only the users InfraWeaver has granted this site BEFORE the
    // proxy provider goes live on the outpost: bind a per-site Authentik access group
    // to the site's application(s) and reconcile its membership from RBAC. Running here
    // (not after) closes the window where forward-auth would otherwise admit any
    // authenticated user. Binding the group restricts the app, so this is fail-closed —
    // a partial member sync over-restricts rather than admitting anyone. A throw aborts
    // activation and the reconcile loop retries (SSO isn't "done" until the gate is scoped).
    { beforeOutpostActivation: () => ensureSiteAccess(site).then(() => undefined) },
  );
  if (!result.oidc) throw new ServiceUnavailableError("Authentik did not return OIDC credentials");

  const pod = await runningWpPod(core, site);
  await execInWpPod(pod, pluginInstallCommand());
  await execInWpPod(pod, optionUpdateFromStdinCommand(OIDC_SETTINGS_OPTION), { stdin: JSON.stringify(buildOidcSettings(result.oidc)) });
}

/**
 * Read-only Site Health snapshot — WP/PHP versions, DB size, active-plugin and
 * available-update counts, and uploads footprint — gathered in one wp-cli/shell
 * batch inside the running site pod. Reuses the same pod-exec path as SSO setup.
 */
export async function getSiteHealth(site: string): Promise<SiteHealth> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { core } = clients();
  const pod = await runningWpPod(core, site);
  const { stdout } = await execInWpPod(pod, siteHealthCommand());
  return parseSiteHealth(stdout);
}

/**
 * Change the Authentik protection scope of an EXISTING site (none → login →
 * admin → full, in any direction). Re-renders and applies the site's IngressRoute
 * (the enforcing object) plus the deny middleware when needed, reflects the mode on
 * the deployment label for listings, and persists it to the vault intent. When the
 * new mode is gated, the reconcile is re-armed so SSO + the per-site access group
 * are (idempotently) provisioned. Downgrading to a less-restrictive mode takes
 * effect immediately via the new IngressRoute; the Authentik app is left in place.
 */
export async function setProtection(site: string, authMode: AuthMode): Promise<SiteSummary> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const { apps, objects } = clients();

  let dep: k8s.V1Deployment;
  try {
    dep = await apps.readNamespacedDeployment({ name: site, namespace: WORDPRESS_NAMESPACE });
  } catch (err) {
    if (isK8sNotFound(err)) throw new SiteNotFoundError(site);
    throw err;
  }
  const labels = dep.metadata?.labels ?? {};
  const domain = labels["infraweaver.io/domain"];
  const internal = labels["infraweaver.io/internal"] === "true";
  const subdomain = labels["infraweaver.io/subdomain"] ?? "";
  const host = domain ? buildHost({ name: subdomain, domain, internal }) : legacySiteHost(site);

  const opts: SiteManifestOptions = { host, authMode, domain, internal, subdomain };
  // The deny middleware is only referenced by "admin" mode; ensure it exists first
  // so the IngressRoute never references a missing middleware.
  if (authMode === "admin") await applyObject(objects, buildDenyMiddleware() as k8s.KubernetesObject);
  await applyObject(objects, buildIngressRoute(site, opts) as k8s.KubernetesObject);

  // Reflect the mode on the deployment label (display cache for listings). Read-modify-
  // replace mirrors applySecrets — avoids version-specific strategic-merge-patch quirks.
  await apps.replaceNamespacedDeployment({
    name: site,
    namespace: WORDPRESS_NAMESPACE,
    body: { ...dep, metadata: { ...dep.metadata, labels: { ...labels, "infraweaver.io/auth-mode": authMode } } },
  });

  // Persist intent. Gating a previously-ungated site re-arms the reconcile so SSO and
  // the access group get provisioned; downgrades keep the prior applied flag.
  const intent = await readIntent(site);
  const plugins = intent?.plugins ?? [];
  const nowGated = isGatedAuthMode(authMode);
  await writeIntent(site, authMode, plugins, intent?.connector ?? false, nowGated ? false : intent?.applied ?? true);
  if (nowGated) {
    settled.delete(site); // clear the settled short-circuit so the reconcile actually re-runs
    triggerReconcile(site);
  }

  const ready = (dep.status?.readyReplicas ?? 0) > 0;
  return { site, host, ready, replicas: dep.spec?.replicas ?? 0, domain, internal, authMode, setupPending: nowGated };
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

  // §5.1 — install + enroll the InfraWeaver Connector. Best-effort like the
  // user sync: a failure logs and leaves the site-settings card as the retry
  // path rather than wedging the whole reconcile loop. Dynamic import because
  // iwsl-managed imports this module (listSites/findWpPodName).
  if (intent.connector) {
    const { enrollManagedSite, getManagedLink } = await import("./iwsl-managed");
    try {
      if (!(await getManagedLink(site))) await enrollManagedSite(site, "provisioner");
    } catch (err) {
      console.warn(`[wordpress] connector enrollment for ${site} failed (enable it from site settings to retry):`, err instanceof Error ? err.message : err);
    }
  }

  // Best-effort: materialize RBAC grants as WordPress accounts. Non-fatal — the
  // grant/revoke hook and the manual access sync re-run it any time.
  await syncSiteWpUsers(site).catch((err) =>
    console.warn(`[wordpress] user sync for ${site} failed (will retry on next access sync):`, err instanceof Error ? err.message : err),
  );

  await writeIntent(site, intent.authMode, intent.plugins, intent.connector, true);
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
    // `settled` is set ONLY here, on success: every rejection routed through
    // `reportReconcileError` leaves the site unsettled (and its vault `applied`
    // flag false), so the next `listSites` poll re-runs this idempotent pass.
    // Success also clears any live SSO-gate alert so the NEXT outage re-arms.
    .then(() => {
      settled.add(site);
      clearSsoUnavailableAlert(site);
    })
    .catch((err) => reportReconcileError(site, err))
    .finally(() => reconcileInFlight.delete(site));
}

/**
 * Log a reconcile failure at the right volume for its cause. Never settles the site
 * — settling is the caller's success-only step — so every branch here leaves the
 * site eligible for the next poll's retry.
 *
 *  - `SsoUnavailableError` — Authentik was unreachable / timed out mid-gate (e.g. the
 *    `ensureProviderOnOutpost` PATCH raced a concurrent reconcile and hit the client's
 *    request timeout). Expected-and-retryable, but it gets its OWN distinct line:
 *    folded into the generic branch it reads exactly like a code fault, and an
 *    operator can't tell "self-heals next poll" from "stuck". This is the alert.
 *  - `ServiceUnavailableError` — the WordPress pod isn't ready yet; normal during
 *    provisioning and retried every poll, so stay silent to avoid log spam.
 *  - anything else — an unexpected fault; log generically.
 */
export function reportReconcileError(site: string, err: unknown): void {
  if (err instanceof SsoUnavailableError) {
    console.warn(`[wordpress] SSO reconcile for ${site} deferred — Authentik unavailable (${err.message}); leaving site unsettled to retry on next poll`);
    // The console.warn above is log-only. Also raise a deduped platform alert
    // (one per outage window, not one per poll) so a stuck gate is visible in the
    // notification bell without log-grepping.
    emitSsoUnavailableAlert(site, err.message);
    return;
  }
  if (err instanceof ServiceUnavailableError) return; // pod not ready — normal, retried next poll
  console.warn(`[wordpress] reconcile for ${site} failed:`, err instanceof Error ? err.message : err);
}
