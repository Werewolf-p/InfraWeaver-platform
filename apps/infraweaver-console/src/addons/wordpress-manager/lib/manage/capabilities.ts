/**
 * Manage-console capability model + panel registry — the single source of truth
 * for which per-site "Manage" tabs are available on a given site and which are
 * disabled because the plugin (or the InfraWeaver Connector) that powers them is
 * not active. Deliberately isomorphic: no `server-only`, no Node imports, no
 * React — it is imported both by the server (to gate the data endpoints) and by
 * the client (to build the visible tab strip and the "Optional (Disabled)" tab).
 *
 * Every panel's data is gathered through the addon's secure in-pod wp-cli path
 * (see lib/manage/probes/*) or the signed IWSL command channel — never a direct
 * database hit. A panel whose backing capability is absent is never rendered with
 * empty/fake data; it moves to the Optional tab with a clear "install X to enable"
 * hint, so the console only ever shows what the site can actually answer for.
 */

/** The 22 Manage sub-panels. Wire ids — used in the `?panel=` API and never renamed. */
export type ManagePanelId =
  | "updates"
  | "inventory"
  | "content"
  | "media"
  | "store"
  | "forms"
  | "backups"
  | "staging"
  | "security"
  | "audit"
  | "performance"
  | "resources"
  | "uptime"
  | "metrics"
  | "audience"
  | "email"
  | "people"
  | "clients"
  | "alerts"
  | "logs"
  | "data"
  | "health";

/** Machine id for a gating capability. `null`-requirement panels need none. */
export type ManageCapabilityId =
  | "woocommerce"
  | "forms"
  | "backups"
  | "smtp"
  | "staging"
  | "seo"
  | "audience"
  | "connector";

/**
 * Candidate plugin slugs whose active presence satisfies a capability. wp.org
 * slugs (the `name` field wp-cli reports), matched case-insensitively against the
 * site's active plugin set. Kept broad so a site using any mainstream plugin in a
 * category lights the panel up rather than being told to install "the one" we picked.
 */
export const WOOCOMMERCE_SLUG = "woocommerce";

export const FORM_PLUGIN_SLUGS: readonly string[] = [
  "contact-form-7",
  "wpforms-lite",
  "wpforms",
  "gravityforms",
  "formidable",
  "ninja-forms",
  "forminator",
  "fluentform",
];

export const BACKUP_PLUGIN_SLUGS: readonly string[] = [
  "updraftplus",
  "backwpup",
  "backwpup-pro",
  "duplicator",
  "all-in-one-wp-migration",
  "wpvivid-backuprestore",
];

export const SMTP_PLUGIN_SLUGS: readonly string[] = [
  "wp-mail-smtp",
  "post-smtp",
  "easy-wp-smtp",
  "fluent-smtp",
  "gmail-smtp",
];

export const SEO_PLUGIN_SLUGS: readonly string[] = [
  "wordpress-seo",
  "seo-by-rank-math",
  "all-in-one-seo-pack",
];

export const ANALYTICS_PLUGIN_SLUGS: readonly string[] = [
  "google-site-kit",
  "ga-google-analytics",
  "matomo",
  "independent-analytics",
  "koko-analytics",
];

export const STAGING_PLUGIN_SLUGS: readonly string[] = ["wp-staging", "wp-staging-pro"];

/** Cache plugins — not a gate (Performance works without one), but detected to report cache posture. */
export const CACHE_PLUGIN_SLUGS: readonly string[] = [
  "wp-super-cache",
  "w3-total-cache",
  "wp-rocket",
  "litespeed-cache",
  "wp-fastest-cache",
  "cache-enabler",
];

/** The site facts a capability check reads. `activePlugins` are lowercased wp.org slugs. */
export interface SiteCapabilityFacts {
  /** Active plugin slugs (lowercased). */
  readonly activePlugins: ReadonlySet<string>;
  /** True when a managed InfraWeaver Connector link exists and is active (signed channel usable). */
  readonly connectorActive: boolean;
}

function anyActive(facts: SiteCapabilityFacts, slugs: readonly string[]): boolean {
  return slugs.some((slug) => facts.activePlugins.has(slug));
}

/** Resolve the concrete capabilities a site currently has. */
export function resolveCapabilities(facts: SiteCapabilityFacts): Record<ManageCapabilityId, boolean> {
  return {
    woocommerce: facts.activePlugins.has(WOOCOMMERCE_SLUG),
    forms: anyActive(facts, FORM_PLUGIN_SLUGS),
    backups: anyActive(facts, BACKUP_PLUGIN_SLUGS),
    smtp: anyActive(facts, SMTP_PLUGIN_SLUGS),
    staging: anyActive(facts, STAGING_PLUGIN_SLUGS),
    seo: anyActive(facts, SEO_PLUGIN_SLUGS),
    audience: anyActive(facts, SEO_PLUGIN_SLUGS) || anyActive(facts, ANALYTICS_PLUGIN_SLUGS),
    connector: facts.connectorActive,
  };
}

/**
 * What a panel needs before it can show real data. `capability` names the gate;
 * `label` is the human name of the thing to enable; `hint` tells the operator how;
 * `installSlug` (when set) is a wp.org slug the Optional tab can offer to install
 * through the existing secure plugin-sync path; `connector` marks a panel powered
 * by the signed IWSL channel rather than a plugin.
 */
export interface PanelRequirement {
  readonly capability: ManageCapabilityId;
  readonly label: string;
  readonly hint: string;
  readonly installSlug?: string;
  readonly connector?: boolean;
}

/** A Manage panel: its id, tab label, icon key (mapped to a lucide icon client-side), and gate. */
export interface ManagePanelDef {
  readonly id: ManagePanelId;
  readonly label: string;
  /** Icon key resolved to a lucide component in the client TAB_ICONS map. */
  readonly icon: string;
  /** One-line description shown on the Optional (Disabled) card. */
  readonly summary: string;
  /** `null` ⇒ always available (core wp-cli). Otherwise the gate that must be satisfied. */
  readonly requires: PanelRequirement | null;
}

/**
 * The full panel catalog, in tab order. Twelve always-available panels backed by
 * core wp-cli, plus nine gated on a plugin category or the signed Connector channel.
 * Ordering here is the ordering the visible tab strip renders.
 */
export const MANAGE_PANELS: readonly ManagePanelDef[] = [
  {
    id: "updates",
    label: "Updates",
    icon: "RefreshCw",
    summary: "Core, plugin and theme updates with one-click apply.",
    requires: null,
  },
  {
    id: "inventory",
    label: "Plugins & Themes",
    icon: "Puzzle",
    summary: "Everything installed, active state and available updates.",
    requires: null,
  },
  {
    id: "content",
    label: "Content",
    icon: "FileText",
    summary: "Posts, pages, comments and revisions at a glance.",
    requires: null,
  },
  {
    id: "media",
    label: "Media",
    icon: "Image",
    summary: "Uploads library size, counts and largest files.",
    requires: null,
  },
  {
    id: "store",
    label: "Store",
    icon: "ShoppingCart",
    summary: "Orders, revenue, products and stock for your shop.",
    requires: {
      capability: "woocommerce",
      label: "WooCommerce",
      hint: "Install and activate WooCommerce to manage orders, products and revenue.",
      installSlug: WOOCOMMERCE_SLUG,
    },
  },
  {
    id: "forms",
    label: "Forms & Leads",
    icon: "Inbox",
    summary: "Form submissions and lead capture across your forms.",
    requires: {
      capability: "forms",
      label: "a forms plugin",
      hint: "Activate Contact Form 7, WPForms, Gravity Forms or similar to track submissions.",
      installSlug: "contact-form-7",
    },
  },
  {
    id: "backups",
    label: "Backups",
    icon: "Archive",
    summary: "Backup schedule, last run and restore points.",
    requires: {
      capability: "backups",
      label: "a backup plugin",
      hint: "Activate UpdraftPlus, BackWPup or similar to schedule and inspect backups.",
      installSlug: "updraftplus",
    },
  },
  {
    id: "staging",
    label: "Staging & Deploys",
    icon: "GitBranch",
    summary: "Clone to staging, test changes and push to live.",
    requires: {
      capability: "staging",
      label: "WP Staging",
      hint: "Activate WP Staging to create staging clones and manage deploys.",
      installSlug: "wp-staging",
    },
  },
  {
    id: "security",
    label: "Security",
    icon: "ShieldCheck",
    summary: "Core file integrity, admin exposure and SSL posture.",
    requires: null,
  },
  {
    id: "audit",
    label: "A11y & SEO Audit",
    icon: "Accessibility",
    summary: "On-page SEO coverage and accessibility findings.",
    requires: {
      capability: "seo",
      label: "an SEO plugin",
      hint: "Activate Yoast SEO or Rank Math to surface on-page SEO and audit coverage.",
      installSlug: "wordpress-seo",
    },
  },
  {
    id: "performance",
    label: "Performance",
    icon: "Gauge",
    summary: "Object cache, autoload weight and PHP runtime posture.",
    requires: null,
  },
  {
    id: "resources",
    label: "Server Resources",
    icon: "Cpu",
    summary: "Pod CPU/memory requests, limits and live usage.",
    requires: null,
  },
  {
    id: "uptime",
    label: "Uptime & Incidents",
    icon: "Activity",
    summary: "Signed liveness checks and connector round-trip health.",
    requires: {
      capability: "connector",
      label: "the InfraWeaver Connector",
      hint: "Enable the InfraWeaver Connector to run signed liveness checks against this site.",
      connector: true,
    },
  },
  {
    id: "metrics",
    label: "Metrics",
    icon: "LineChart",
    summary: "Live signed telemetry plus Prometheus history for the Connector link.",
    requires: {
      capability: "connector",
      label: "the InfraWeaver Connector",
      hint: "Enable the InfraWeaver Connector to read signed telemetry and Prometheus history for this site.",
      connector: true,
    },
  },
  {
    id: "audience",
    label: "Traffic & SEO",
    icon: "TrendingUp",
    summary: "Search visibility and traffic signals from your SEO/analytics plugin.",
    requires: {
      capability: "audience",
      label: "an SEO or analytics plugin",
      hint: "Activate Yoast SEO, Rank Math or an analytics plugin to report traffic and search data.",
      installSlug: "wordpress-seo",
    },
  },
  {
    id: "email",
    label: "Email",
    icon: "Mail",
    summary: "SMTP delivery configuration and send health.",
    requires: {
      capability: "smtp",
      label: "an SMTP plugin",
      hint: "Activate WP Mail SMTP or Post SMTP to configure and monitor transactional email.",
      installSlug: "wp-mail-smtp",
    },
  },
  {
    id: "people",
    label: "Users",
    icon: "Users",
    summary: "WordPress accounts, roles and recent authors.",
    requires: null,
  },
  {
    id: "clients",
    label: "Clients & Care",
    icon: "Briefcase",
    summary: "Care-plan status rolled up over the signed Connector channel.",
    requires: {
      capability: "connector",
      label: "the InfraWeaver Connector",
      hint: "Enable the InfraWeaver Connector to roll up care-plan and maintenance status.",
      connector: true,
    },
  },
  {
    id: "alerts",
    label: "Alerts",
    icon: "BellRing",
    summary: "Derived alerts from update, security and health signals.",
    requires: null,
  },
  {
    id: "logs",
    label: "Logs",
    icon: "ScrollText",
    summary: "Recent PHP/WordPress debug log entries from the pod.",
    requires: null,
  },
  {
    id: "data",
    label: "Database",
    icon: "Database",
    summary: "Table sizes, autoload weight, transients and overhead.",
    requires: null,
  },
  {
    id: "health",
    label: "Health",
    icon: "HeartPulse",
    summary: "WordPress Site Health checks, versions and cron status.",
    requires: null,
  },
];

const PANELS_BY_ID: ReadonlyMap<ManagePanelId, ManagePanelDef> = new Map(
  MANAGE_PANELS.map((panel) => [panel.id, panel]),
);

export function getPanelDef(id: string): ManagePanelDef | undefined {
  return PANELS_BY_ID.get(id as ManagePanelId);
}

export function isManagePanelId(id: string): id is ManagePanelId {
  return PANELS_BY_ID.has(id as ManagePanelId);
}

/** Availability verdict for one panel given a site's capabilities. */
export interface PanelAvailability {
  readonly id: ManagePanelId;
  readonly available: boolean;
}

/** True when a panel's gate (if any) is satisfied by the resolved capabilities. */
export function isPanelAvailable(
  panel: ManagePanelDef,
  capabilities: Record<ManageCapabilityId, boolean>,
): boolean {
  if (!panel.requires) return true;
  return capabilities[panel.requires.capability] === true;
}

/** Compute the availability verdict for every panel — powers the tab strip + Optional tab split. */
export function computePanelAvailability(
  capabilities: Record<ManageCapabilityId, boolean>,
): PanelAvailability[] {
  return MANAGE_PANELS.map((panel) => ({ id: panel.id, available: isPanelAvailable(panel, capabilities) }));
}
