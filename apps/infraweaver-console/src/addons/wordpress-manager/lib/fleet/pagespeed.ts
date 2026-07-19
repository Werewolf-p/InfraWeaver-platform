import "server-only";
import { requestSafeExternalUrl } from "@/lib/outbound-url";
import { withCache } from "../manage/snapshot-cache";
import { getCachedFleet } from "./aggregate";
import type { FleetSiteRow } from "./types";

/**
 * Fleet-wide Google PageSpeed Insights (PSI v5) integration — the real, optional
 * field/lab performance signal for the Performance tab. It DEGRADES HONESTLY:
 * with no `PAGESPEED_API_KEY` set it returns `configured:false` and an empty site
 * list (never fabricated scores), exactly like the metrics probe degrades when
 * Prometheus is unconfigured. When a key is present it runs a mobile + desktop
 * Lighthouse audit per managed site, over the SSRF-safe outbound path
 * (`requestSafeExternalUrl`), and folds the whole roll-up through the per-replica
 * SWR cache (~10 min) so the tab paints instantly and reconciles behind the view.
 *
 * The site list comes straight from the already-cached fleet aggregation — no new
 * pod execs are done here.
 */

/** PSI v5 endpoint. Public Google host, so it passes the SSRF allow-list. */
const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
/** A full Lighthouse round-trip is slow; give each strategy a generous ceiling. */
const PSI_TIMEOUT_MS = 15_000;
/** A performance-only PSI payload is well under this; a hard bound caps memory. */
const PSI_MAX_RESPONSE_BYTES = 6_000_000;
/** Cap concurrent PSI work so a large fleet never fans out unbounded. */
const PSI_CONCURRENCY = 6;
/** SWR window for the whole fleet PageSpeed roll-up. */
const PAGESPEED_CACHE_KEY = "fleet::pagespeed";
const PAGESPEED_CACHE_FRESH_MS = 10 * 60_000;

/** The honest "not configured" reason surfaced to the UI verbatim. */
const UNCONFIGURED_REASON = "PageSpeed needs PAGESPEED_API_KEY configured.";

/** One site's PSI result. Numeric fields are null when unmeasured or on error. */
export interface FleetPageSpeedSite {
  readonly site: string;
  readonly url: string;
  /** Lighthouse performance score 0–100 (mobile strategy), or null. */
  readonly mobile: number | null;
  /** Lighthouse performance score 0–100 (desktop strategy), or null. */
  readonly desktop: number | null;
  /** Largest Contentful Paint in milliseconds (mobile), or null. */
  readonly lcpMs: number | null;
  /** Cumulative Layout Shift (mobile), or null. */
  readonly cls: number | null;
  /** Present only when the site's PSI query failed. */
  readonly error?: string;
}

export interface FleetPageSpeed {
  /** False when `PAGESPEED_API_KEY` is unset — the UI shows `reason`, not gauges. */
  readonly configured: boolean;
  /** Human-readable reason PageSpeed is degraded (only when `configured:false`). */
  readonly reason?: string;
  readonly sites: readonly FleetPageSpeedSite[];
}

interface StrategyMetrics {
  readonly score: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
}

/**
 * Read a numeric leaf out of untrusted JSON by walking a key path, returning null
 * unless every hop is an object and the leaf is a finite number. Keeps the parsed
 * PSI response as `unknown` (external data) with no `any`.
 */
function readNumberPath(root: unknown, path: readonly string[]): number | null {
  let current: unknown = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function extractMetrics(json: unknown): StrategyMetrics {
  const rawScore = readNumberPath(json, ["lighthouseResult", "categories", "performance", "score"]);
  const lcpMs = readNumberPath(json, ["lighthouseResult", "audits", "largest-contentful-paint", "numericValue"]);
  const cls = readNumberPath(json, ["lighthouseResult", "audits", "cumulative-layout-shift", "numericValue"]);
  return {
    // PSI reports the category score as a 0–1 fraction; surface it as 0–100.
    score: rawScore === null ? null : Math.round(rawScore * 100),
    lcpMs: lcpMs === null ? null : Math.round(lcpMs),
    cls: cls === null ? null : Math.round(cls * 100) / 100,
  };
}

/** Run one PSI strategy for a site URL. Throws on transport/HTTP failure. */
async function runPsi(siteUrl: string, strategy: "mobile" | "desktop", key: string): Promise<unknown> {
  const params = new URLSearchParams({
    url: siteUrl,
    strategy,
    category: "performance",
    key,
  });
  const response = await requestSafeExternalUrl(`${PSI_ENDPOINT}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    timeoutMs: PSI_TIMEOUT_MS,
    maxResponseBytes: PSI_MAX_RESPONSE_BYTES,
  });
  if (!response) throw new Error("PageSpeed endpoint could not be reached safely.");
  if (response.status !== 200) throw new Error(`PageSpeed API returned ${response.status}.`);
  return JSON.parse(response.body.toString("utf8")) as unknown;
}

async function pageSpeedForSite(row: FleetSiteRow, key: string): Promise<FleetPageSpeedSite> {
  const url = `https://${row.url}`;
  try {
    const [mobileJson, desktopJson] = await Promise.all([
      runPsi(url, "mobile", key),
      runPsi(url, "desktop", key),
    ]);
    const mobile = extractMetrics(mobileJson);
    const desktop = extractMetrics(desktopJson);
    // LCP/CLS come from the mobile run — the field-representative strategy.
    return { site: row.name, url, mobile: mobile.score, desktop: desktop.score, lcpMs: mobile.lcpMs, cls: mobile.cls };
  } catch (err) {
    return {
      site: row.name,
      url,
      mobile: null,
      desktop: null,
      lcpMs: null,
      cls: null,
      error: err instanceof Error ? err.message : "PageSpeed query failed.",
    };
  }
}

/** Query every site, at most `PSI_CONCURRENCY` in flight, failing soft per site. */
async function pageSpeedForFleet(rows: readonly FleetSiteRow[], key: string): Promise<FleetPageSpeedSite[]> {
  const out: FleetPageSpeedSite[] = [];
  for (let i = 0; i < rows.length; i += PSI_CONCURRENCY) {
    const chunk = rows.slice(i, i + PSI_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((row) => pageSpeedForSite(row, key)));
    settled.forEach((outcome, j) => {
      if (outcome.status === "fulfilled") {
        out.push(outcome.value);
      } else {
        // pageSpeedForSite already fails soft, so this is defence-in-depth.
        const row = chunk[j];
        out.push({
          site: row.name,
          url: `https://${row.url}`,
          mobile: null,
          desktop: null,
          lcpMs: null,
          cls: null,
          error: outcome.reason instanceof Error ? outcome.reason.message : "PageSpeed query failed.",
        });
      }
    });
  }
  return out;
}

async function computeFleetPageSpeed(): Promise<FleetPageSpeed> {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    // Honest degradation: no key ⇒ no scores at all, never invented numbers.
    return { configured: false, reason: UNCONFIGURED_REASON, sites: [] };
  }
  const fleet = await getCachedFleet();
  const rows = fleet.value.sites;
  if (rows.length === 0) return { configured: true, sites: [] };
  const sites = await pageSpeedForFleet(rows, key);
  return { configured: true, sites };
}

/** Fleet PageSpeed roll-up through the per-replica SWR cache. */
export async function getFleetPageSpeed(): Promise<FleetPageSpeed> {
  const cached = await withCache(PAGESPEED_CACHE_KEY, PAGESPEED_CACHE_FRESH_MS, computeFleetPageSpeed);
  return cached.value;
}
