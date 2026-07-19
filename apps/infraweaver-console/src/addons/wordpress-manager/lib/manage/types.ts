/**
 * Isomorphic response types for the Manage console API — shared by the server
 * (overview.ts) and the client (use-manage hook + panels). No `server-only`, no
 * Node: importable from a "use client" component without pulling the exec layer.
 */
import type { ManageCapabilityId, ManagePanelId } from "./capabilities";
import type { ConnectorMetricsResult } from "../rpc/registry";

/** One point in a Prometheus-sourced history series: unix seconds + value. */
export interface MetricsHistoryPoint {
  readonly t: number;
  readonly v: number;
}

/** A named time-series for the metrics panel's history charts. */
export interface MetricsHistorySeries {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly points: readonly MetricsHistoryPoint[];
}

/**
 * Metrics panel payload. `live` is an on-demand signed `metrics.snapshot` read —
 * NOT persisted anywhere; `checkedAt` is exactly when that signed round-trip
 * happened (the "last checked at" the UI shows). `history` is read from
 * Prometheus (the durable store the ServiceMonitor scrapes into); it degrades to
 * `available:false` with a reason when Prometheus is unconfigured/unreachable, so
 * the live read still works on its own.
 */
export interface ConnectorMetricsPanelData {
  readonly live: {
    readonly ok: boolean;
    /** ISO timestamp of this signed read — the "last checked at" value. */
    readonly checkedAt: string;
    readonly roundtripMs: number | null;
    readonly result: ConnectorMetricsResult | null;
    /** Present when the signed read failed or the plugin rejected it. */
    readonly error?: string;
  };
  readonly history: {
    readonly available: boolean;
    readonly windowHours: number;
    /** Why history is unavailable (Prometheus unconfigured/unreachable). */
    readonly reason?: string;
    readonly series: readonly MetricsHistorySeries[];
  };
}

/** Connector liveness rolled into the overview from the managed link (signed channel). */
export interface OverviewConnector {
  readonly active: boolean;
  readonly lastRoundtripMs: number | null;
  readonly lastCheckIso: string | null;
  readonly connectorVersion: string | null;
}

/** Availability verdict for one panel given a site's capabilities. */
export interface PanelAvailability {
  readonly id: ManagePanelId;
  readonly available: boolean;
}

/** The Manage overview payload the tab strip + header render from. */
export interface ManageOverview {
  readonly site: string;
  readonly wpVersion: string | null;
  readonly phpVersion: string | null;
  readonly coreUpdate: boolean;
  readonly pendingUpdates: number;
  readonly pluginUpdates: number;
  readonly themeUpdates: number;
  readonly activePlugins: number;
  readonly totalPlugins: number;
  readonly dbSizeMb: number | null;
  readonly uploadsMb: number | null;
  readonly cachePlugin: string | null;
  readonly health: number;
  readonly connector: OverviewConnector;
  readonly capabilities: Record<ManageCapabilityId, boolean>;
  readonly panels: readonly PanelAvailability[];
  /** Epoch ms the snapshot was gathered (present on cached API responses). */
  readonly cachedAt?: number;
  /** True when served from a stale snapshot while a background refresh runs. */
  readonly stale?: boolean;
}
