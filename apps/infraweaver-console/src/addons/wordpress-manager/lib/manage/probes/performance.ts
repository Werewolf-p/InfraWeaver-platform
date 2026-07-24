/**
 * Performance panel probe — cache posture (a persistent object-cache drop-in and/or
 * an active page-cache plugin), autoloaded-option weight, the PHP runtime (version +
 * memory limit) and stored-transient count, plus a set of derived recommendations —
 * all read live from the pod. Cache/runtime facts use WP_SAFE; the page-cache plugin
 * match needs plugin state, so that one read uses full wp-cli. The three tuning
 * actions (flush cache, flush rewrites, purge transients) route through the
 * allow-listed Manage actions, not this probe.
 */
import { WP, WP_SAFE, kvLine, parseKv, activePluginSlugs, toInt, toNum, toStr } from "../wp-probe";
import { CACHE_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Autoload weight over ~800 KB is the widely-cited "audit your autoloaded options" line. */
const AUTOLOAD_WARN_KB = 800;
/** A large transient backlog bloats the options table; flag for a purge past this. */
const TRANSIENT_WARN = 500;

/** Sum of autoloaded-option lengths in KB. Prefix comes from wp-cli, never input. */
const AUTOLOAD_KB_CMD =
  `${WP_SAFE} db query "SELECT ROUND(SUM(LENGTH(option_value))/1024,2) FROM ` +
  `$(${WP_SAFE} db prefix)options WHERE autoload IN ('yes','on','auto','auto-on')" --skip-column-names`;

/** Detected page-cache owner: our own IWSL drop-in ranks first, then a third-party plugin. */
export type PageCacheOwner = "iwsl" | string | null;

export interface PerformanceData {
  /** A `wp-content/object-cache.php` drop-in is present. */
  readonly objectCacheDropin: boolean;
  /** Backend `wp cache type` reports (e.g. "Redis", "Memcached", "Default"). */
  readonly cacheType: string | null;
  /** True when a persistent object cache is actually in effect. */
  readonly persistentObjectCache: boolean;
  /** True when OUR `advanced-cache.php` drop-in (signature match) is installed. */
  readonly iwslPageCache: boolean;
  /** The page-cache owner, ranked: `"iwsl"` when our drop-in is live, else a third-party slug, else null. */
  readonly pageCache: PageCacheOwner;
  /** Slug of an active THIRD-PARTY page-cache plugin, or null (for the conflict note). */
  readonly pageCachePlugin: string | null;
  readonly autoloadKb: number | null;
  readonly php: string | null;
  readonly memoryLimit: string | null;
  readonly transients: number;
  readonly recommendations: readonly string[];
}

function buildRecommendations(input: {
  persistentObjectCache: boolean;
  iwslPageCache: boolean;
  pageCachePlugin: string | null;
  autoloadKb: number | null;
  transients: number;
}): string[] {
  const recs: string[] = [];
  if (!input.persistentObjectCache) {
    recs.push("No persistent object cache detected — add Redis or Memcached to cut repeat database queries.");
  }
  // Only nudge toward a page cache when NEITHER our own drop-in NOR a third-party
  // plugin is present. With our cache live we never recommend a competitor (the
  // bug this fixes); a foreign plugin is surfaced by name in the panel, not here.
  if (!input.iwslPageCache && !input.pageCachePlugin) {
    recs.push("No page cache is active — turn on the built-in Page Cache to serve pages straight from cache.");
  }
  if (input.autoloadKb !== null && input.autoloadKb > AUTOLOAD_WARN_KB) {
    recs.push(`Autoloaded options weigh ${input.autoloadKb} KB — audit oversized autoloaded options.`);
  }
  if (input.transients > TRANSIENT_WARN) {
    recs.push(`${input.transients} transients are stored — purge them to slim the options table.`);
  }
  return recs;
}

export function parsePerformance(input: { scalars: string; plugins: string; autoloadKb: string }): PerformanceData {
  const kv = parseKv(input.scalars);
  const active = activePluginSlugs(input.plugins);
  const pageCachePlugin = CACHE_PLUGIN_SLUGS.find((slug) => active.has(slug)) ?? null;
  const iwslPageCache = (kv.get("IWSL_PAGE_CACHE_DROPIN") ?? "").trim() === "present";
  // Our drop-in ranks first so the console recognises its OWN cache before any plugin.
  const pageCache: PageCacheOwner = iwslPageCache ? "iwsl" : pageCachePlugin;

  const cacheType = toStr(kv.get("CACHE_TYPE"));
  const objectCacheDropin = (kv.get("OBJECT_CACHE_DROPIN") ?? "").trim() === "present";
  const persistentObjectCache = objectCacheDropin || (!!cacheType && !/default/i.test(cacheType));

  const autoloadKb = toNum(input.autoloadKb);
  const transients = toInt(kv.get("TRANSIENTS")) ?? 0;

  return {
    objectCacheDropin,
    cacheType,
    persistentObjectCache,
    iwslPageCache,
    pageCache,
    pageCachePlugin,
    autoloadKb,
    php: toStr(kv.get("PHP_VERSION")),
    memoryLimit: toStr(kv.get("MEMORY_LIMIT")),
    transients,
    recommendations: buildRecommendations({ persistentObjectCache, iwslPageCache, pageCachePlugin, autoloadKb, transients }),
  };
}

async function fetchPerformance(ctx: PanelProbeContext): Promise<PerformanceData> {
  const scalarsCmd = [
    kvLine("OBJECT_CACHE_DROPIN", `test -f wp-content/object-cache.php && echo present || echo absent`),
    // Our OWN page-cache drop-in, matched by its baked signature (IWSL_Page_Cache::SIGNATURE).
    // Batched into the same single exec as the other scalars — zero extra round-trips.
    kvLine("IWSL_PAGE_CACHE_DROPIN", `grep -q "signature: iwsl-page-cache" wp-content/advanced-cache.php 2>/dev/null && echo present || echo absent`),
    kvLine("CACHE_TYPE", `${WP_SAFE} cache type`),
    kvLine("PHP_VERSION", `php -r 'echo PHP_VERSION;'`),
    kvLine("MEMORY_LIMIT", `php -r 'echo ini_get("memory_limit");'`),
    kvLine("TRANSIENTS", `${WP_SAFE} transient list --format=count`),
  ].join("\n");

  const [scalars, plugins, autoloadKb] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP} plugin list --status=active --field=name --format=json`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx.exec(AUTOLOAD_KB_CMD).then((r) => r.stdout).catch(() => ""),
  ]);

  return parsePerformance({ scalars, plugins, autoloadKb });
}

export const performanceProbe: PanelProbe<PerformanceData> = {
  id: "performance",
  fetch: fetchPerformance,
};
