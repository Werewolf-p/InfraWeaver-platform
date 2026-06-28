export type PluginCategory = "sso" | "security" | "performance" | "seo" | "backup";

export interface PluginDef {
  slug: string;
  name: string;
  description: string;
  category: PluginCategory;
  recommended?: boolean;
  /** True for the Authentik SSO plugin, which has its own configuration flow. */
  sso?: boolean;
}

/**
 * The plugins the manager offers. `slug` is the wordpress.org plugin slug used by
 * `wp plugin install`. The Authentik SSO entry is special-cased by the SSO flow
 * (see authentik.ts) — selecting it provisions the OIDC provider and configures
 * the plugin, rather than just installing it.
 */
export const PLUGIN_CATALOG: ReadonlyArray<PluginDef> = [
  { slug: "daggerhart-openid-connect-generic", name: "Authentik SSO (OpenID Connect)", description: "Single sign-on through Authentik via OpenID Connect.", category: "sso", recommended: true, sso: true },
  { slug: "wordfence", name: "Wordfence Security", description: "Firewall and malware scanning.", category: "security", recommended: true },
  { slug: "limit-login-attempts-reloaded", name: "Limit Login Attempts", description: "Block brute-force login attempts.", category: "security", recommended: true },
  { slug: "wp-super-cache", name: "WP Super Cache", description: "Static page caching for speed.", category: "performance" },
  { slug: "wordpress-seo", name: "Yoast SEO", description: "Search-engine optimisation toolkit.", category: "seo" },
  { slug: "updraftplus", name: "UpdraftPlus Backups", description: "Scheduled backups to remote storage.", category: "backup" },
];

export const AUTHENTIK_PLUGIN_SLUG = "daggerhart-openid-connect-generic";

export function getPlugin(slug: string): PluginDef | undefined {
  return PLUGIN_CATALOG.find((plugin) => plugin.slug === slug);
}

export interface PluginSyncPlan {
  toInstall: string[];
  toRemove: string[];
  unchanged: string[];
}

/**
 * Diff desired plugin set against what's installed. Only catalog plugins are
 * considered for removal, so manually-installed plugins outside the manager are
 * left alone rather than being torn out from under the user.
 */
export function buildPluginSyncPlan(desired: string[], installed: string[]): PluginSyncPlan {
  const desiredSet = new Set(desired);
  const installedSet = new Set(installed);
  const catalogSlugs = new Set(PLUGIN_CATALOG.map((plugin) => plugin.slug));

  const toInstall = [...desiredSet].filter((slug) => !installedSet.has(slug));
  const toRemove = [...installedSet].filter((slug) => !desiredSet.has(slug) && catalogSlugs.has(slug));
  const unchanged = [...desiredSet].filter((slug) => installedSet.has(slug));
  return { toInstall, toRemove, unchanged };
}

function quoteSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`refusing unsafe plugin slug: ${slug}`);
  return slug;
}

export function installPluginCommand(slug: string): string {
  return `wp --allow-root plugin install ${quoteSlug(slug)} --activate`;
}

export function removePluginCommand(slug: string): string {
  return `wp --allow-root plugin deactivate ${quoteSlug(slug)} && wp --allow-root plugin delete ${quoteSlug(slug)}`;
}

export function listPluginsCommand(): string {
  return "wp --allow-root plugin list --field=name --status=active,inactive";
}

/** The ordered shell commands to converge installed plugins onto `desired`. */
export function buildPluginSyncCommands(plan: PluginSyncPlan): string[] {
  return [
    ...plan.toInstall.map(installPluginCommand),
    ...plan.toRemove.map(removePluginCommand),
  ];
}
