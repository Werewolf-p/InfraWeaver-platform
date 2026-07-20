import type { ManageOverview } from "./types";

/**
 * Prometheus exposition for the per-site Manage KPIs (`iwsl_site_*`). This is the
 * NUMERIC-history half of the fast-page mechanism: the durable snapshot (site-
 * snapshot.ts) drives instant structured display, while these gauges give the
 * numeric bits — plugin/theme/update counts, DB + uploads size, health — a
 * time-series in Prometheus so they can be graphed over hours/days. The exporter
 * renders these straight from the durable snapshots (no wp-cli at scrape time),
 * so a 60s scrape stays cheap and every value is as fresh as the last sweep.
 *
 * Deliberately low-cardinality: only counts and scalars become gauges; the string
 * facts (WP/PHP version, cache plugin) ride a single `iwsl_site_info` series as
 * labels (value always 1), never one series per value. No plugin/theme LISTS are
 * ever exported.
 *
 * Pure and cluster-free (given `Date.now()` for the age gauge), so the whole
 * renderer is unit-testable without a Prometheus or a pod.
 */

const METRIC_PREFIX = "iwsl_site";

/** One site's KPI sample: the durable overview plus when it was captured. */
export interface SiteKpiSample {
  readonly site: string;
  readonly overview: ManageOverview;
  /** Epoch ms the underlying snapshot was gathered. */
  readonly at: number;
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labels(pairs: Record<string, string>): string {
  const inner = Object.entries(pairs)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `{${inner}}`;
}

/** One numeric gauge across all samples, with its HELP/TYPE header. */
interface GaugeSpec {
  name: string;
  help: string;
  /** Per-sample value, or null to omit the series for that sample. */
  value: (s: SiteKpiSample) => number | null;
}

const GAUGES: readonly GaugeSpec[] = [
  { name: "health", help: "Composite site-health score (35–100) from the last snapshot.", value: (s) => s.overview.health },
  { name: "plugins_total", help: "Total installed plugins.", value: (s) => s.overview.totalPlugins },
  { name: "plugins_active", help: "Active plugins.", value: (s) => s.overview.activePlugins },
  { name: "plugins_update_available", help: "Plugins with an update available.", value: (s) => s.overview.pluginUpdates },
  { name: "themes_update_available", help: "Themes with an update available.", value: (s) => s.overview.themeUpdates },
  { name: "core_update_available", help: "1 when a WordPress core update is available, else 0.", value: (s) => (s.overview.coreUpdate ? 1 : 0) },
  { name: "pending_updates", help: "Total pending updates (plugins + themes + core).", value: (s) => s.overview.pendingUpdates },
  { name: "db_megabytes", help: "Database size in megabytes.", value: (s) => s.overview.dbSizeMb },
  { name: "uploads_megabytes", help: "wp-content/uploads size in megabytes.", value: (s) => s.overview.uploadsMb },
  { name: "connector_up", help: "1 when the IWSL Connector link is active on this site, else 0.", value: (s) => (s.overview.connector.active ? 1 : 0) },
  { name: "connector_roundtrip_milliseconds", help: "Last Connector signed round-trip latency in milliseconds.", value: (s) => s.overview.connector.lastRoundtripMs },
  {
    name: "snapshot_age_seconds",
    help: "Age of the durable snapshot this sample was rendered from, in seconds.",
    value: (s) => (s.at > 0 ? Math.max(0, Math.round((Date.now() - s.at) / 1000)) : null),
  },
];

function renderGauge(spec: GaugeSpec, samples: readonly SiteKpiSample[]): string[] {
  const lines: string[] = [
    `# HELP ${METRIC_PREFIX}_${spec.name} ${spec.help}`,
    `# TYPE ${METRIC_PREFIX}_${spec.name} gauge`,
  ];
  for (const s of samples) {
    const value = spec.value(s);
    if (value === null || !Number.isFinite(value)) continue;
    lines.push(`${METRIC_PREFIX}_${spec.name}${labels({ site: s.site })} ${value}`);
  }
  return lines;
}

/**
 * Render per-site KPI samples into Prometheus text exposition (v0.0.4). Pure and
 * deterministic given `samples` (only the age gauge reads the wall clock). An
 * `iwsl_site_info` series carries the string facts (WP/PHP version, cache plugin)
 * as labels; every numeric KPI is a gauge under `iwsl_site_*`. Always emits the
 * fleet-count header first, so an empty fleet is still a well-formed exposition.
 */
export function renderSiteMetrics(samples: readonly SiteKpiSample[]): string {
  const lines: string[] = [];

  lines.push(`# HELP ${METRIC_PREFIX}_snapshots Number of sites with a durable Manage snapshot rendered this scrape.`);
  lines.push(`# TYPE ${METRIC_PREFIX}_snapshots gauge`);
  lines.push(`${METRIC_PREFIX}_snapshots ${samples.length}`);

  // Version/plugin facts as an info gauge (value always 1; identity in the labels).
  lines.push(`# HELP ${METRIC_PREFIX}_info Site build info; value is always 1, facts are in the labels.`);
  lines.push(`# TYPE ${METRIC_PREFIX}_info gauge`);
  for (const s of samples) {
    const lbls = labels({
      site: s.site,
      wp: s.overview.wpVersion ?? "",
      php: s.overview.phpVersion ?? "",
      cache_plugin: s.overview.cachePlugin ?? "",
    });
    lines.push(`${METRIC_PREFIX}_info${lbls} 1`);
  }

  for (const spec of GAUGES) {
    lines.push(...renderGauge(spec, samples));
  }

  // Exposition format requires a trailing newline.
  return `${lines.join("\n")}\n`;
}
