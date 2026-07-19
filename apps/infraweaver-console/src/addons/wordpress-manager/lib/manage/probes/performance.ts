/**
 * Performance panel probe — cache posture (a persistent object-cache drop-in and/or
 * an active page-cache plugin), autoloaded-option weight, the PHP runtime (version +
 * memory limit) and stored-transient count, plus a set of derived recommendations —
 * all read live from the pod. Cache/runtime facts use WP_SAFE; the page-cache plugin
 * match needs plugin state, so that one read uses full wp-cli. The three tuning
 * actions (flush cache, flush rewrites, purge transients) route through the
 * allow-listed Manage actions, not this probe.
 */
import { WP, WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, toNum, toStr } from "../wp-probe";
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

export interface PerformanceData {
  /** A `wp-content/object-cache.php` drop-in is present. */
  readonly objectCacheDropin: boolean;
  /** Backend `wp cache type` reports (e.g. "Redis", "Memcached", "Default"). */
  readonly cacheType: string | null;
  /** True when a persistent object cache is actually in effect. */
  readonly persistentObjectCache: boolean;
  /** Slug of the active page-cache plugin, or null when none is active. */
  readonly pageCachePlugin: string | null;
  readonly autoloadKb: number | null;
  readonly php: string | null;
  readonly memoryLimit: string | null;
  readonly transients: number;
  readonly recommendations: readonly string[];
}

function buildRecommendations(input: {
  persistentObjectCache: boolean;
  pageCachePlugin: string | null;
  autoloadKb: number | null;
  transients: number;
}): string[] {
  const recs: string[] = [];
  if (!input.persistentObjectCache) {
    recs.push("No persistent object cache detected — add Redis or Memcached to cut repeat database queries.");
  }
  if (!input.pageCachePlugin) {
    recs.push("No page-cache plugin is active — consider WP Rocket, W3 Total Cache or LiteSpeed Cache.");
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
  const active = parseJsonArray<string>(input.plugins).map((slug) => String(slug).toLowerCase());
  const pageCachePlugin = CACHE_PLUGIN_SLUGS.find((slug) => active.includes(slug)) ?? null;

  const cacheType = toStr(kv.get("CACHE_TYPE"));
  const objectCacheDropin = (kv.get("OBJECT_CACHE_DROPIN") ?? "").trim() === "present";
  const persistentObjectCache = objectCacheDropin || (!!cacheType && !/default/i.test(cacheType));

  const autoloadKb = toNum(input.autoloadKb);
  const transients = toInt(kv.get("TRANSIENTS")) ?? 0;

  return {
    objectCacheDropin,
    cacheType,
    persistentObjectCache,
    pageCachePlugin,
    autoloadKb,
    php: toStr(kv.get("PHP_VERSION")),
    memoryLimit: toStr(kv.get("MEMORY_LIMIT")),
    transients,
    recommendations: buildRecommendations({ persistentObjectCache, pageCachePlugin, autoloadKb, transients }),
  };
}

async function fetchPerformance(ctx: PanelProbeContext): Promise<PerformanceData> {
  const scalarsCmd = [
    kvLine("OBJECT_CACHE_DROPIN", `test -f wp-content/object-cache.php && echo present || echo absent`),
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
