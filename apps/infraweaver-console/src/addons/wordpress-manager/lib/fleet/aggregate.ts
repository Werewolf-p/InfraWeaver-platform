import "server-only";
import { listSites, type SiteSummary } from "../provision";
import { listExternalSiteViews, type ExternalSiteView } from "../iwsl-enrollment";
import { loadManageOverview } from "../manage/overview";
import { withCache, type Cached } from "../manage/snapshot-cache";
import { mapWithConcurrency } from "../concurrency";
import type { FleetData, FleetSiteRow, FleetSiteStatus, FleetSummary } from "./types";

/**
 * Real fleet aggregation — the live, secure replacement for the seeded fleet
 * dashboard. Rolls up every provisioned site from three secure sources, never
 * fabricated data:
 *   - `listSites()`               — provisioned sites + pod readiness (k8s).
 *   - `listExternalSiteViews()`   — the signed IWSL Connector link (state, last
 *                                   signed health round-trip, version, rejections).
 *   - `getManageOverview(site)`   — in-pod wp-cli health/versions/updates (the
 *                                   same secure exec path the Manage console uses).
 *
 * Per-site reads run concurrently under allSettled, so one unreadable pod never
 * blanks the fleet. The whole roll-up is served through the per-replica SWR cache
 * (like the manage panels), so the dashboard paints instantly and reconciles.
 */

const FLEET_FRESH_MS = 30_000;

/**
 * Max sites rolled up at once. Opening a single site's Overview live-pulls the
 * whole fleet through this path (via the /fleet insights card), so an unbounded
 * fan-out was a thundering herd of wp-cli execs against every pod. Bounded like
 * the panel-capture sweep (PANEL_CAPTURE_CONCURRENCY = 3) so one open tab can
 * never stampede the cluster or the console event loop.
 */
const FLEET_ROLLUP_CONCURRENCY = 3;

/** Health thresholds for the rollup status (composite Site-Health score 0–100). */
const CRITICAL_BELOW = 55;
const ATTENTION_BELOW = 80;

function deriveStatus(input: {
  offline: boolean;
  health: number | null;
  coreUpdate: boolean;
  pendingUpdates: number;
}): FleetSiteStatus {
  if (input.offline || input.health === null) return "offline";
  if (input.health < CRITICAL_BELOW) return "critical";
  if (input.health < ATTENTION_BELOW || input.coreUpdate || input.pendingUpdates > 0) return "attention";
  return "healthy";
}

function findLink(links: ExternalSiteView[], site: string): ExternalSiteView | undefined {
  return links.find((l) => l.managed && l.siteName === site);
}

async function rollupSite(site: SiteSummary, links: ExternalSiteView[]): Promise<FleetSiteRow> {
  const link = findLink(links, site.site);
  const connectorState = link?.state ?? null;
  const connectorVersion = link?.connectorVersion ?? null;
  const lastHealth = link?.lastHealth ?? null;
  const rejections = link?.rejections ?? 0;

  // The in-pod wp-cli overview is the source for health/versions/updates. It can
  // fail (pod restarting, DB blip) — that's a real "offline" signal, not an error.
  // Read through loadManageOverview: the durable cross-replica snapshot first (kept
  // warm by the manage-sweep cron), falling back to the per-site SWR cache — never
  // a raw uncached live pull, which is what stampeded every pod on a single view.
  let health: number | null = null;
  let php: string | null = null;
  let wp: string | null = null;
  let core = 0;
  let plugins = 0;
  let themes = 0;
  let coreUpdate = false;
  let overviewFailed = false;
  try {
    const ov = (await loadManageOverview(site.site)).value;
    health = ov.health;
    php = ov.phpVersion;
    wp = ov.wpVersion;
    core = ov.coreUpdate ? 1 : 0;
    coreUpdate = ov.coreUpdate;
    plugins = ov.pluginUpdates;
    themes = ov.themeUpdates;
  } catch {
    overviewFailed = true;
  }

  const offline = !site.ready || overviewFailed;
  const pendingUpdates = core + plugins + themes;
  const status = deriveStatus({ offline, health, coreUpdate, pendingUpdates });

  return {
    id: site.site,
    name: site.site,
    url: site.host,
    status,
    health,
    responseMs: typeof lastHealth?.roundtripMs === "number" ? lastHealth.roundtripMs : null,
    updates: { core, plugins, themes },
    php,
    wp,
    connectorVersion,
    connectorState,
    lastHealthAt: lastHealth?.at ?? null,
    lastHealthOk: lastHealth ? lastHealth.ok : null,
    rejections,
    offline,
  };
}

/** A fully-offline row for a site whose rollup could not be produced at all. */
function offlineRow(site: SiteSummary): FleetSiteRow {
  return {
    id: site.site,
    name: site.site,
    url: site.host,
    status: "offline",
    health: null,
    responseMs: null,
    updates: { core: 0, plugins: 0, themes: 0 },
    php: null,
    wp: null,
    connectorVersion: null,
    connectorState: null,
    lastHealthAt: null,
    lastHealthOk: null,
    rejections: 0,
    offline: true,
  };
}

function summarize(rows: FleetSiteRow[], links: ExternalSiteView[]): FleetSummary {
  const responseValues = rows.map((r) => r.responseMs).filter((v): v is number => typeof v === "number");
  return {
    total: rows.length,
    healthy: rows.filter((r) => r.status === "healthy").length,
    attention: rows.filter((r) => r.status === "attention").length,
    critical: rows.filter((r) => r.status === "critical").length,
    offline: rows.filter((r) => r.status === "offline").length,
    updatesPending: rows.reduce((n, r) => n + r.updates.core + r.updates.plugins + r.updates.themes, 0),
    avgResponse: responseValues.length
      ? Math.round(responseValues.reduce((a, b) => a + b, 0) / responseValues.length)
      : null,
    connected: links.filter((l) => l.managed && l.state === "active" && l.fingerprintConfirmed).length,
  };
}

/** Aggregate the whole fleet from live secure sources (uncached). */
export async function aggregateFleet(): Promise<FleetData> {
  const [sites, links] = await Promise.all([listSites(), listExternalSiteViews()]);
  // Bounded fan-out (FLEET_ROLLUP_CONCURRENCY): rollupSite already folds its own
  // failures into an offline row, and the .catch guards the pool against an
  // unexpected throw so one bad site never rejects the whole roll-up.
  const rows: FleetSiteRow[] = (
    await mapWithConcurrency(sites, FLEET_ROLLUP_CONCURRENCY, (site) =>
      rollupSite(site, links).catch(() => offlineRow(site)),
    )
  ).sort((a, b) => (a.health ?? -1) - (b.health ?? -1)); // worst first — attention rises to the top

  return {
    summary: summarize(rows, links),
    sites: rows,
    generatedAt: new Date().toISOString(),
  };
}

/** Fleet roll-up through the per-replica SWR cache. */
export function getCachedFleet(): Promise<Cached<FleetData>> {
  return withCache("fleet::all", FLEET_FRESH_MS, aggregateFleet);
}
