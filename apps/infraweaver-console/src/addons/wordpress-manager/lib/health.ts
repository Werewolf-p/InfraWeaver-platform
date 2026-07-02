/**
 * Site Health — a read-only snapshot of a WordPress site's runtime state gathered
 * in a single `wp-cli`/shell batch inside the running pod. Pure helpers here (command
 * string + output parser) so they're unit-testable without a cluster; the exec lives
 * in provision.ts (`getSiteHealth`), which already owns the pod-exec plumbing.
 */

export interface SiteHealth {
  /** WordPress core version, e.g. "6.5.2". */
  wpVersion: string | null;
  /** PHP runtime version, e.g. "8.2.18". */
  phpVersion: string | null;
  /** Database size in MB (WordPress tables). */
  dbSizeMb: number | null;
  /** Count of active plugins. */
  activePlugins: number | null;
  /** Count of plugins with an available update. */
  pluginUpdates: number | null;
  /** wp-content/uploads size in MB. */
  uploadsMb: number | null;
}

/**
 * One shell batch emitting `KEY=VALUE` lines. `--allow-root` because the official
 * WordPress image runs wp-cli as root. Each probe is guarded so a single failure
 * (e.g. DB briefly unreachable) yields an empty value rather than aborting the batch.
 */
export function siteHealthCommand(): string {
  return [
    'echo "WP_VERSION=$(wp --allow-root core version 2>/dev/null)"',
    `echo "PHP_VERSION=$(php -r 'echo PHP_VERSION;' 2>/dev/null)"`,
    'echo "DB_SIZE_MB=$(wp --allow-root db size --size_format=mb 2>/dev/null)"',
    'echo "PLUGINS_ACTIVE=$(wp --allow-root plugin list --status=active --field=name 2>/dev/null | grep -c .)"',
    'echo "PLUGIN_UPDATES=$(wp --allow-root plugin list --update=available --field=name 2>/dev/null | grep -c .)"',
    'echo "UPLOADS_MB=$(du -sm wp-content/uploads 2>/dev/null | cut -f1)"',
  ].join("\n");
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value.trim().replace(/mb$/i, ""));
  return Number.isFinite(n) ? n : null;
}

function str(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Parse the `KEY=VALUE` batch output into a SiteHealth. Tolerant of extra lines. */
export function parseSiteHealth(stdout: string): SiteHealth {
  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    kv.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return {
    wpVersion: str(kv.get("WP_VERSION")),
    phpVersion: str(kv.get("PHP_VERSION")),
    dbSizeMb: num(kv.get("DB_SIZE_MB")),
    activePlugins: num(kv.get("PLUGINS_ACTIVE")),
    pluginUpdates: num(kv.get("PLUGIN_UPDATES")),
    uploadsMb: num(kv.get("UPLOADS_MB")),
  };
}
