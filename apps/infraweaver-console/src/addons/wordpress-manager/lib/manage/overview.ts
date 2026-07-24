import "server-only";
import * as k8s from "@kubernetes/client-node";
import { loadKubeConfig } from "@/lib/k8s";
import { WORDPRESS_NAMESPACE } from "../wordpress-rbac";
import { assertValidSiteId } from "../naming";
import { execInWpPod } from "../k8s-exec";
import { siteExists } from "../provision";
import { SiteNotFoundError, ServiceUnavailableError } from "../errors";
import { getManagedLink } from "../iwsl-managed";
import { WP, WP_SAFE, parseJsonArray, parseKv, toInt, toNum, toStr, fieldStr } from "./wp-probe";
import {
  CACHE_PLUGIN_SLUGS,
  computePanelAvailability,
  resolveCapabilities,
} from "./capabilities";
import { siteHasEntitlement } from "../tiers";
import { seoStatus } from "../iwsl-managed-ops";
import { summarizeSeoStatus, type SeoSummary } from "./seo";
import type { ManageOverview } from "./types";
import { withCache, overviewKey, invalidateManageCache, type Cached } from "./snapshot-cache";
import { readSiteSnapshot, writeSiteSnapshot } from "./site-snapshot";

/**
 * The Manage-console overview: one call that discovers a site's running pod,
 * reads its active plugin set (⇒ which optional panels are available), and
 * gathers the header summary — all through the addon's secure in-pod wp-cli path.
 * The per-panel detail is fetched lazily afterwards (see panel-data.ts). Keeping
 * capability detection here means the tab strip and the "Optional (Disabled)" tab
 * are computed from what the site can actually answer for, never guessed.
 */

export type { ManageOverview, OverviewConnector } from "./types";

/** How long an overview snapshot is served without a background refresh. */
const OVERVIEW_FRESH_MS = 30_000;

type PluginRow = {
  name?: string;
  status?: string;
  update?: string;
  version?: string;
};

function clients() {
  const kc = loadKubeConfig();
  return { core: kc.makeApiClient(k8s.CoreV1Api) };
}

/**
 * The running WordPress pod for a site, or a typed 503 when none is Running. A
 * self-contained copy of provision.ts's private `runningWpPod` so the Manage
 * layer carries its own pod-resolution rather than reaching into provisioning.
 */
export async function requireRunningWpPod(site: string): Promise<string> {
  const { core } = clients();
  const pods = await core.listNamespacedPod({
    namespace: WORDPRESS_NAMESPACE,
    labelSelector: `infraweaver.io/site=${site},infraweaver.io/component=wordpress`,
  });
  const pod = (pods.items ?? []).find((p) => p.status?.phase === "Running");
  if (!pod?.metadata?.name) throw new ServiceUnavailableError("WordPress pod is not running yet");
  return pod.metadata.name;
}

/** KEY=VALUE scalar summary batch — versions, db/uploads size, active-plugin count. */
function summaryCommand(): string {
  return [
    `echo "WP_VERSION=$(${WP_SAFE} core version 2>/dev/null)"`,
    `echo "PHP_VERSION=$(php -r 'echo PHP_VERSION;' 2>/dev/null)"`,
    `echo "DB_SIZE_MB=$(${WP_SAFE} db size --size_format=mb 2>/dev/null)"`,
    `echo "UPLOADS_MB=$(du -sm wp-content/uploads 2>/dev/null | cut -f1)"`,
    `echo "USER_COUNT=$(${WP_SAFE} user list --format=count 2>/dev/null)"`,
    `echo "CORE_UPDATE=$(${WP_SAFE} core check-update --field=version --format=count 2>/dev/null)"`,
  ].join("\n");
}

/** Composite health score from real signals: penalise pending updates, stale core, missing db read. */
function computeHealth(input: {
  pendingUpdates: number;
  coreUpdate: boolean;
  phpMajor: number | null;
  dbReadable: boolean;
}): number {
  let score = 100;
  score -= Math.min(30, input.pendingUpdates * 4);
  if (input.coreUpdate) score -= 15;
  if (input.phpMajor !== null && input.phpMajor < 8) score -= 12;
  if (!input.dbReadable) score -= 20;
  return Math.max(35, Math.min(100, score));
}

/** Parse `wp plugin list --format=json` rows into active/total counts + active-slug set + cache detection. */
export function parsePluginInventory(rows: PluginRow[]): {
  activeSlugs: Set<string>;
  activeCount: number;
  totalCount: number;
  updates: number;
  cachePlugin: string | null;
} {
  const activeSlugs = new Set<string>();
  let activeCount = 0;
  let updates = 0;
  for (const row of rows) {
    const name = fieldStr(row, "name")?.toLowerCase() ?? null;
    const active = (fieldStr(row, "status") ?? "").startsWith("active");
    if (name && active) {
      activeSlugs.add(name);
      activeCount += 1;
    }
    if (fieldStr(row, "update") === "available") updates += 1;
  }
  const cachePlugin = CACHE_PLUGIN_SLUGS.find((slug) => activeSlugs.has(slug)) ?? null;
  return { activeSlugs, activeCount, totalCount: rows.length, updates, cachePlugin };
}

export async function getManageOverview(site: string): Promise<ManageOverview> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const pod = await requireRunningWpPod(site);

  // Parallel, failure-isolated probes: a broken theme list must not sink plugin
  // detection, and the managed-link read is cluster-independent.
  const [summaryOut, pluginsOut, themesOut, managed] = await Promise.all([
    execInWpPod(pod, summaryCommand()).then((r) => r.stdout).catch(() => ""),
    execInWpPod(pod, `${WP} plugin list --format=json --fields=name,status,update,version`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    execInWpPod(pod, `${WP} theme list --format=json --fields=name,status,update,version`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    getManagedLink(site).catch(() => null),
  ]);

  const kv = parseKv(summaryOut);
  const wpVersion = toStr(kv.get("WP_VERSION"));
  const phpVersion = toStr(kv.get("PHP_VERSION"));
  const dbSizeMb = toNum(kv.get("DB_SIZE_MB"));
  const uploadsMb = toNum(kv.get("UPLOADS_MB"));
  const userCount = toInt(kv.get("USER_COUNT"));
  const coreUpdate = (toInt(kv.get("CORE_UPDATE")) ?? 0) > 0;

  const inventory = parsePluginInventory(parseJsonArray<PluginRow>(pluginsOut));
  const themeUpdates = parseJsonArray<PluginRow>(themesOut).filter(
    (t) => fieldStr(t, "update") === "available",
  ).length;

  const pluginUpdates = inventory.updates;
  const pendingUpdates = pluginUpdates + themeUpdates + (coreUpdate ? 1 : 0);

  const connectorActive = managed?.state === "active" && managed.fingerprintConfirmed === true;
  const platformSeo =
    siteHasEntitlement(managed ?? undefined, "seo_audit") || siteHasEntitlement(managed ?? undefined, "seo_suite");
  const capabilities = resolveCapabilities({ activePlugins: inventory.activeSlugs, connectorActive, platformSeo });

  // Best-effort engine-aware SEO summary for the Overview tile + attention feed
  // (A1/A2). Attempted only over a live signed link; ANY failure — an old connector
  // (`unknown-method` → 501), a locked reply, a transient pod blip — degrades to a
  // `measured:false` summary ("not measured"), never an error, so the overview's hot
  // path never fails on SEO. Off-link sites carry no tile at all (null).
  const seo: SeoSummary | null = connectorActive
    ? summarizeSeoStatus(await seoStatus(site).catch(() => null))
    : null;

  const phpMajor = phpVersion ? toInt(phpVersion.split(".")[0]) : null;
  const health = computeHealth({
    pendingUpdates,
    coreUpdate,
    phpMajor,
    dbReadable: dbSizeMb !== null,
  });

  return {
    site,
    wpVersion,
    phpVersion,
    coreUpdate,
    pendingUpdates,
    pluginUpdates,
    themeUpdates,
    activePlugins: inventory.activeCount,
    totalPlugins: inventory.totalCount,
    dbSizeMb,
    uploadsMb,
    userCount,
    cachePlugin: inventory.cachePlugin,
    health,
    connector: {
      active: !!connectorActive,
      lastRoundtripMs: managed?.lastHealth?.roundtripMs ?? null,
      lastCheckIso: managed?.lastHealth?.at ?? null,
      connectorVersion: managed?.connectorVersion ?? null,
    },
    capabilities,
    panels: computePanelAvailability(capabilities),
    seo,
  };
}

/**
 * Overview through the stale-while-revalidate cache: a reopened Manage page (or a
 * second viewer) is served the last snapshot instantly while a fresh read runs
 * behind it, instead of blocking on a cold pod round-trip every time.
 */
export function getCachedManageOverview(site: string): Promise<Cached<ManageOverview>> {
  return withCache(overviewKey(site), OVERVIEW_FRESH_MS, () => getManageOverview(site));
}

/**
 * Beyond this age a durable snapshot is flagged `stale` so the header can hint
 * "last refreshed a while ago". Sized to the hourly sweep cadence plus slack — a
 * healthy fleet is rarely stale; a wedged sweep shows through.
 */
const SNAPSHOT_STALE_MS = 90 * 60 * 1000;

/**
 * The page's overview read. Prefers the DURABLE cross-replica snapshot so a cold
 * page load — a fresh replica, a restart, a first-ever view — paints instantly
 * from the last sweep instead of blocking on three wp-cli execs. Only pulls live
 * when the caller forces a renew (`force`) or the site has never been swept, and
 * then writes the fresh overview back to both the durable store and the SWR cache
 * so the next load is instant too. Force-renew first drops the per-replica SWR so
 * the pull is genuinely live, not a 30s-stale hit.
 */
export async function loadManageOverview(
  site: string,
  opts: { force?: boolean } = {},
): Promise<Cached<ManageOverview>> {
  if (!opts.force) {
    const durable = await readSiteSnapshot(site).catch(() => null);
    if (durable) {
      return {
        value: durable.overview,
        cachedAt: durable.at,
        stale: Date.now() - durable.at > SNAPSHOT_STALE_MS,
      };
    }
  }

  if (opts.force) invalidateManageCache(site);
  const cached = await getCachedManageOverview(site);
  // Persist durably so the next cold/cross-replica load is instant. Best-effort:
  // a snapshot-store blip must never fail the read that already has fresh data.
  await writeSiteSnapshot(site, cached.value, cached.cachedAt).catch((err) => {
    console.warn(`[wordpress] durable snapshot write for ${site} failed:`, err instanceof Error ? err.message : err);
  });
  return cached;
}
