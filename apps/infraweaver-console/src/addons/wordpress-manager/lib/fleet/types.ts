/**
 * Isomorphic fleet-dashboard types — shared by the server aggregator
 * (lib/fleet/aggregate.ts) and the client fleet components. No `server-only`, no
 * Node: safe to import from a "use client" component.
 *
 * Every field here is sourced from a real, secure signal (provisioned-site state,
 * the signed IWSL Connector link, or the in-pod wp-cli manage probes) — never
 * seeded. Series with no secure source yet (traffic, WAF, PageSpeed) are modelled
 * as their own optional integrations, not folded into fabricated defaults.
 */

/** Per-site rollup status, matching the widgets' STATUS_TONE/STATUS_LABEL keys. */
export type FleetSiteStatus = "healthy" | "attention" | "critical" | "offline";

/** One managed site, rolled up from its real signals. */
export interface FleetSiteRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: FleetSiteStatus;
  /** Composite Site-Health score 0–100 (from the health probe), or null when unreadable. */
  readonly health: number | null;
  /** Last signed health-check round-trip (ms), or null when never/uncommandable. */
  readonly responseMs: number | null;
  readonly updates: { readonly core: number; readonly plugins: number; readonly themes: number };
  readonly php: string | null;
  readonly wp: string | null;
  /** Running Connector version, or null when the site has no signed link. */
  readonly connectorVersion: string | null;
  /** Signed-link state: active/pending/quarantined, or null when not enrolled. */
  readonly connectorState: string | null;
  /** ISO of the last signed health check, or null. */
  readonly lastHealthAt: string | null;
  readonly lastHealthOk: boolean | null;
  /** §12.5 verify/enrollment rejections. */
  readonly rejections: number;
  /** True when the pod is not ready / unreadable. */
  readonly offline: boolean;
}

export interface FleetSummary {
  readonly total: number;
  readonly healthy: number;
  readonly attention: number;
  readonly critical: number;
  readonly offline: number;
  readonly updatesPending: number;
  /** Mean signed round-trip across commandable links (ms), or null when none. */
  readonly avgResponse: number | null;
  /** Managed sites with an active, fingerprint-confirmed signed link. */
  readonly connected: number;
}

export interface FleetData {
  readonly summary: FleetSummary;
  readonly sites: readonly FleetSiteRow[];
  /** ISO the aggregation ran (the "last checked at" for the fleet). */
  readonly generatedAt: string;
  /** Present on cached API responses. */
  readonly cachedAt?: number;
  readonly stale?: boolean;
}
