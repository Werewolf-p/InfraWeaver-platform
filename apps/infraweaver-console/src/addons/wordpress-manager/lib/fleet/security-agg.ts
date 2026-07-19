import "server-only";
import { getCachedFleet } from "./aggregate";
import { withCache } from "../manage/snapshot-cache";
import type { FleetSiteRow } from "./types";

/**
 * Real fleet-security roll-up — the live, secure replacement for the seeded
 * Security tab. The posture is derived entirely from the same secure signals the
 * fleet aggregator already gathers (provisioned-site readiness, the signed IWSL
 * Connector link state/rejections, and in-pod wp-cli update state) — never
 * fabricated.
 *
 * Two feeds that would need an integration we have NOT wired degrade honestly
 * rather than inventing data:
 *   - `vulnerabilities` — no CVE/security-plugin feed is wired, so it reports
 *     `configured:false` with a reason and an empty item list (no invented CVEs).
 *   - `waf` — no WAF/security-plugin data channel is wired, so it reports
 *     `configured:false` with a reason (no invented block events).
 *
 * Served through the per-replica SWR snapshot cache (like the manage panels), so
 * the tab paints instantly and reconciles behind it. Read-only; `wordpress:read`.
 */

/** How long a security roll-up is served before a background refresh. */
const SECURITY_FRESH_MS = 60_000;

const VULN_REASON =
  "Vulnerability feed not configured — needs a CVE/security-plugin integration.";
const WAF_REASON =
  "WAF metrics need a security plugin (e.g. Wordfence) exposing data over the signed channel.";

/** One managed site's security-relevant posture, all from real fleet signals. */
export interface FleetSecuritySiteRow {
  readonly site: string;
  /** WordPress core security/feature update is pending. */
  readonly coreUpdate: boolean;
  /** Number of plugins with a pending update. */
  readonly pluginUpdates: number;
  /** Signed-link state: active/pending/quarantined, or null when not enrolled. */
  readonly connectorState: string | null;
  /** §12.5 verify/enrollment rejections on the signed link. */
  readonly rejections: number;
  /** Composite Site-Health score 0–100, or null when the pod is unreadable/offline. */
  readonly health: number | null;
  /** Pod not ready / unreadable. */
  readonly offline: boolean;
}

/** Aggregate posture counts across the whole fleet. */
export interface FleetSecurityPosture {
  readonly totalSites: number;
  /** Sites with a pending core update. */
  readonly coreUpdatesPending: number;
  /** Sites with one or more pending plugin updates. */
  readonly pluginUpdatesPending: number;
  /** Sites whose signed link is quarantined or is rejecting signed commands. */
  readonly quarantined: number;
  /** Sites whose pod is offline / unreadable. */
  readonly offline: number;
  /** Total §12.5 rejections summed across every link. */
  readonly rejectionsTotal: number;
  readonly rows: readonly FleetSecuritySiteRow[];
}

/** Honestly-degraded vulnerability feed — no CVE integration is wired. */
export interface FleetSecurityVulnerabilities {
  readonly configured: boolean;
  readonly reason?: string;
  /** Always empty until a feed is wired; typed to forbid fabricated entries. */
  readonly items: readonly never[];
}

/** Honestly-degraded WAF feed — no security-plugin data channel is wired. */
export interface FleetSecurityWaf {
  readonly configured: boolean;
  readonly reason?: string;
}

export interface FleetSecurity {
  readonly posture: FleetSecurityPosture;
  readonly vulnerabilities: FleetSecurityVulnerabilities;
  readonly waf: FleetSecurityWaf;
  /** ISO the roll-up ran (the "last checked at" for the security tab). */
  readonly generatedAt: string;
  /** Present on cached API responses. */
  readonly cachedAt?: number;
  readonly stale?: boolean;
}

/** A link is a security concern when quarantined or actively rejecting signed commands. */
function isQuarantinedOrRejecting(row: FleetSiteRow): boolean {
  return row.connectorState === "quarantined" || row.rejections > 0;
}

function toSecurityRow(row: FleetSiteRow): FleetSecuritySiteRow {
  return {
    site: row.name,
    coreUpdate: row.updates.core > 0,
    pluginUpdates: row.updates.plugins,
    connectorState: row.connectorState,
    rejections: row.rejections,
    health: row.health,
    offline: row.offline,
  };
}

function buildPosture(rows: readonly FleetSiteRow[]): FleetSecurityPosture {
  return {
    totalSites: rows.length,
    coreUpdatesPending: rows.filter((r) => r.updates.core > 0).length,
    pluginUpdatesPending: rows.filter((r) => r.updates.plugins > 0).length,
    quarantined: rows.filter(isQuarantinedOrRejecting).length,
    offline: rows.filter((r) => r.offline).length,
    rejectionsTotal: rows.reduce((n, r) => n + r.rejections, 0),
    rows: rows.map(toSecurityRow),
  };
}

/** Uncached security roll-up from the live secure fleet aggregation. */
async function aggregateFleetSecurity(): Promise<FleetSecurity> {
  const fleet = await getCachedFleet();
  return {
    posture: buildPosture(fleet.value.sites),
    vulnerabilities: { configured: false, reason: VULN_REASON, items: [] },
    waf: { configured: false, reason: WAF_REASON },
    generatedAt: new Date().toISOString(),
  };
}

/** Fleet security roll-up through the per-replica SWR cache. */
export async function getFleetSecurity(): Promise<FleetSecurity> {
  const cached = await withCache("fleet::security", SECURITY_FRESH_MS, aggregateFleetSecurity);
  return { ...cached.value, cachedAt: cached.cachedAt, stale: cached.stale };
}
