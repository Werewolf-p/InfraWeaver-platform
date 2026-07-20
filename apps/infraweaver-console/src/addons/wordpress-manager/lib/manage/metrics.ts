import "server-only";
import { listExternalSites, type ExternalSiteRecord } from "../iwsl-link-store";
import {
  connectorMetrics,
  externalConnectorMetrics,
  type ConnectorMetrics,
} from "../iwsl-managed-ops";
import type { ConnectorMetricsResult } from "../rpc/registry";
import { withCache } from "./snapshot-cache";
import { readAllSnapshots } from "./site-snapshot";
import { renderSiteMetrics, type SiteKpiSample } from "./site-kpis";

/**
 * Prometheus exporter for the IWSL Connector fleet. Every series is sourced from
 * a signed `metrics.snapshot` command — the same dual-signed, pinned-key-verified
 * channel as health.check — so a value is trusted only after its response
 * signature checks out (a tampered reply quarantines the link and never reaches a
 * gauge). This is the cross-replica-persistent counterpart to the per-tab manage
 * snapshot cache: instead of painting a panel, it renders the numeric series into
 * the text exposition format Prometheus scrapes.
 *
 * Two halves, split so the formatting is unit-testable without a cluster:
 *   - collectConnectorMetrics() does the signed I/O (managed over exec, external
 *     over HTTPS), each link fetched through the SWR cache so a 30s scrape never
 *     blocks on a fresh ~2.7s signed round-trip per site.
 *   - renderConnectorMetrics() is a pure (samples → exposition text) function.
 */

/** Series/label prefix — one namespace for every Connector gauge. */
const METRIC_PREFIX = "iwsl_connector";

/**
 * How long a per-site snapshot stays fresh before a background refresh. Sized
 * under a typical 30–60s Prometheus scrape interval so most scrapes serve the
 * last snapshot instantly while one refresh runs behind them (SWR). Each signed
 * round-trip is seconds (SLH-DSA dominates), so we must not re-scrape every site
 * synchronously on every Prometheus poll.
 */
const METRICS_FRESH_MS = 30_000;

type MetricsTransport = "exec" | "https";

/** The signed-fetch outcome for one link, before cache metadata is folded in. */
interface MetricsFetch {
  up: boolean;
  roundtripMs: number | null;
  result: ConnectorMetricsResult | null;
  /** Present when the fetch failed (transport error) or the plugin rejected it. */
  error?: string;
}

/** One link's metrics plus how fresh the reading is. */
export interface ConnectorMetricSample extends MetricsFetch {
  site: string;
  transport: MetricsTransport;
  /** Epoch ms the underlying snapshot was gathered. */
  cachedAt: number;
  /** True when served from a stale cache entry while a refresh runs behind it. */
  stale: boolean;
}

interface MetricsTarget {
  site: string;
  transport: MetricsTransport;
  fetch: () => Promise<ConnectorMetrics>;
}

/** Active, fingerprint-confirmed §5.1 managed links — scraped over k8s exec. */
function isScrapableManaged(site: ExternalSiteRecord): boolean {
  return Boolean(site.managed) && Boolean(site.siteName) && site.state === "active" && site.fingerprintConfirmed;
}

/** Active, fingerprint-confirmed §5 external links — scraped over HTTPS. */
function isScrapableExternal(site: ExternalSiteRecord): boolean {
  return !site.managed && site.state === "active" && site.fingerprintConfirmed;
}

function buildTargets(sites: ExternalSiteRecord[]): MetricsTarget[] {
  const managed = sites.filter(isScrapableManaged).map((site): MetricsTarget => {
    const siteName = site.siteName as string;
    return { site: siteName, transport: "exec", fetch: () => connectorMetrics(siteName) };
  });
  const external = sites.filter(isScrapableExternal).map((site): MetricsTarget => ({
    site: site.siteId,
    transport: "https",
    fetch: () => externalConnectorMetrics(site.siteId),
  }));
  return [...managed, ...external];
}

/** Narrow the plugin's untyped `result` into the numeric snapshot shape. */
function asMetricsResult(result: Record<string, unknown>): ConnectorMetricsResult | null {
  if (typeof result.last_seq !== "number") return null;
  return result as unknown as ConnectorMetricsResult;
}

/**
 * One link's signed metrics fetch, normalized to a value that never throws — a
 * dead pod or a plugin rejection becomes `up:false` with a reason, so one bad
 * link can't blank the whole scrape.
 */
async function fetchOne(target: MetricsTarget): Promise<MetricsFetch> {
  try {
    const reply = await target.fetch();
    if (reply.rejectedReason) {
      return { up: false, roundtripMs: reply.roundtripMs, result: null, error: reply.rejectedReason };
    }
    return { up: reply.ok, roundtripMs: reply.roundtripMs, result: asMetricsResult(reply.result) };
  } catch (err) {
    return { up: false, roundtripMs: null, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Scrape every commandable link, each through the SWR cache. Concurrent +
 * per-link isolated (allSettled), so total wall-time is one round of the slowest
 * refresh, never the sum, and one unreachable site never rejects the batch.
 */
export async function collectConnectorMetrics(): Promise<ConnectorMetricSample[]> {
  const sites = await listExternalSites();
  const targets = buildTargets(sites);

  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<ConnectorMetricSample> => {
      const cached = await withCache(`metrics::${target.transport}::${target.site}`, METRICS_FRESH_MS, () =>
        fetchOne(target),
      );
      return { site: target.site, transport: target.transport, ...cached.value, cachedAt: cached.cachedAt, stale: cached.stale };
    }),
  );

  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          site: targets[i].site,
          transport: targets[i].transport,
          up: false,
          roundtripMs: null,
          result: null,
          error: String(outcome.reason),
          cachedAt: 0,
          stale: false,
        },
  );
}

// ── Exposition rendering (pure) ──────────────────────────────────────────────

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

/** One numeric gauge series across all samples, with its HELP/TYPE header. */
interface GaugeSpec {
  name: string;
  help: string;
  /** Per-sample value, or null to omit this series for that sample. */
  value: (s: ConnectorMetricSample) => number | null;
  /** Extra labels beyond `site`. */
  extraLabels?: (s: ConnectorMetricSample) => Record<string, string>;
}

const GAUGES: GaugeSpec[] = [
  {
    name: "up",
    help: "Whether the last signed metrics.snapshot to this Connector succeeded (1) or failed (0).",
    value: (s) => (s.up ? 1 : 0),
    extraLabels: (s) => ({ transport: s.transport }),
  },
  {
    name: "roundtrip_milliseconds",
    help: "Signed metrics.snapshot round-trip latency in milliseconds.",
    value: (s) => (s.roundtripMs ?? null),
    extraLabels: (s) => ({ transport: s.transport }),
  },
  {
    name: "metrics_cache_age_seconds",
    help: "Age of the cached snapshot this sample was served from, in seconds.",
    value: (s) => (s.cachedAt > 0 ? Math.max(0, Math.round((Date.now() - s.cachedAt) / 1000)) : null),
  },
  {
    name: "metrics_stale",
    help: "1 when the sample was served from a stale cache entry while a refresh ran behind it.",
    value: (s) => (s.stale ? 1 : 0),
  },
  { name: "last_seq", help: "Highest command seq the link has committed (§6.3 replay watermark).", value: (s) => s.result?.last_seq ?? null },
  { name: "nonce_cache_entries", help: "Live replay-nonce cache size.", value: (s) => s.result?.nonce_cache ?? null },
  { name: "wp_key_epoch", help: "Current WordPress signing-key epoch (kid).", value: (s) => s.result?.wp_kid ?? null },
  { name: "iw_key_epoch", help: "Current pinned InfraWeaver key epoch (kid).", value: (s) => s.result?.iw_kid ?? null },
  { name: "wp_epoch_floor", help: "Lowest WordPress key epoch still accepted.", value: (s) => s.result?.wp_epoch_floor ?? null },
  { name: "iw_epoch_floor", help: "Lowest InfraWeaver key epoch still accepted.", value: (s) => s.result?.iw_epoch_floor ?? null },
  { name: "rotation_pending", help: "1 when a key rotation is prepared but not yet confirmed (§8).", value: (s) => s.result?.rotation_pending ?? null },
  { name: "sodium_available", help: "1 when libsodium is available on the site for signing/verification.", value: (s) => s.result?.sodium ?? null },
  { name: "last_reroll_timestamp_seconds", help: "Unix time of the last signing-key reroll, 0 if never (§8).", value: (s) => s.result?.last_reroll_at ?? null },
  { name: "last_reroll_ok", help: "Whether the last signing-key reroll confirmed (1) or aborted/failed (0).", value: (s) => s.result?.last_reroll_ok ?? null },
];

function renderGauge(spec: GaugeSpec, samples: ConnectorMetricSample[]): string[] {
  const lines: string[] = [`# HELP ${METRIC_PREFIX}_${spec.name} ${spec.help}`, `# TYPE ${METRIC_PREFIX}_${spec.name} gauge`];
  for (const s of samples) {
    const value = spec.value(s);
    if (value === null || !Number.isFinite(value)) continue;
    const lbls = labels({ site: s.site, ...(spec.extraLabels?.(s) ?? {}) });
    lines.push(`${METRIC_PREFIX}_${spec.name}${lbls} ${value}`);
  }
  return lines;
}

/**
 * Render collected samples into Prometheus text exposition format (v0.0.4). Pure
 * and deterministic given `samples` (cache-age uses the wall clock only). An
 * `_info` gauge carries the string versions as labels (the Prometheus idiom for
 * non-numeric facts); every numeric series is a gauge under `iwsl_connector_*`.
 */
export function renderConnectorMetrics(samples: ConnectorMetricSample[]): string {
  const lines: string[] = [];

  // Fleet-level scrape health first, so a scrape that reached zero live links is
  // still a well-formed, non-empty exposition (targets=0, up=0) rather than blank.
  lines.push(`# HELP ${METRIC_PREFIX}_scrape_targets Number of commandable Connector links this scrape targeted.`);
  lines.push(`# TYPE ${METRIC_PREFIX}_scrape_targets gauge`);
  lines.push(`${METRIC_PREFIX}_scrape_targets ${samples.length}`);
  lines.push(`# HELP ${METRIC_PREFIX}_scrape_up Number of targeted links that answered a verified metrics.snapshot.`);
  lines.push(`# TYPE ${METRIC_PREFIX}_scrape_up gauge`);
  lines.push(`${METRIC_PREFIX}_scrape_up ${samples.filter((s) => s.up).length}`);

  // Version/build facts as an info gauge (value always 1; identity in the labels).
  lines.push(`# HELP ${METRIC_PREFIX}_info Connector build info; value is always 1, facts are in the labels.`);
  lines.push(`# TYPE ${METRIC_PREFIX}_info gauge`);
  for (const s of samples) {
    if (!s.result) continue;
    const lbls = labels({ site: s.site, plugin: s.result.plugin, php: s.result.php, wp: s.result.wp ?? "" });
    lines.push(`${METRIC_PREFIX}_info${lbls} 1`);
  }

  for (const spec of GAUGES) {
    lines.push(...renderGauge(spec, samples));
  }

  // Exposition format requires a trailing newline.
  return `${lines.join("\n")}\n`;
}

/** Collect and render in one call — what the token-gated route serves. */
export async function exportConnectorMetrics(): Promise<string> {
  return renderConnectorMetrics(await collectConnectorMetrics());
}

// ── Per-site Manage KPIs (from the durable snapshots) ────────────────────────

/**
 * Read every site's durable Manage snapshot into KPI samples. Unlike the
 * connector collector this does NO signed round-trip — it reads the hourly-swept
 * ConfigMap snapshots, so the scrape is one cheap read and the values are as
 * fresh as the last sweep. Fail-soft: a missing/unreadable store degrades to an
 * empty sample list (a well-formed, non-blank exposition downstream), so a
 * snapshot blip never breaks the connector metrics served alongside it.
 */
export async function collectSiteKpiSamples(): Promise<SiteKpiSample[]> {
  try {
    const snapshots = await readAllSnapshots();
    return [...snapshots.entries()].map(([site, snap]) => ({ site, overview: snap.overview, at: snap.at }));
  } catch (err) {
    console.warn("[wordpress:iwsl] site KPI snapshot read failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Collect + render the per-site `iwsl_site_*` KPI exposition. */
export async function exportSiteMetrics(): Promise<string> {
  return renderSiteMetrics(await collectSiteKpiSamples());
}
