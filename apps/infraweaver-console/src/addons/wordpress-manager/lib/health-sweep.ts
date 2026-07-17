import "server-only";
import { listExternalSites, type ExternalSiteRecord } from "./iwsl-link-store";
import {
  connectorHealthCheck,
  externalConnectorHealthCheck,
  type ConnectorHealth,
} from "./iwsl-managed-ops";

/**
 * Server-driven connector health sweep (§12.5). Runs the same signed
 * `health.check` round-trip the operator triggers by hand, but across every
 * commandable link at once — so `lastHealth`, `connectorVersion`, and the
 * derived "update available" badge stay fresh regardless of who has a browser
 * open. Invoked hourly by the health-sweep CronJob.
 *
 * BOTH link families are swept, each over its own transport:
 *   - §5.1 managed links → `connectorHealthCheck` over the k8s-exec channel.
 *   - §5 external links   → `externalConnectorHealthCheck` over the public
 *                           HTTPS command channel (IW initiates the POST; the
 *                           site never dials in — §2 invariant intact).
 * Only active + fingerprint-confirmed links are targeted; both check functions
 * fail-closed on anything else, so a quarantined or half-enrolled link would
 * just error. Each site is isolated in its own try/catch under a single
 * Promise.allSettled — one unreachable pod OR one dead external endpoint must
 * never abort the rest of the batch.
 */

type SweepTransport = "exec" | "https";

interface SweepTarget {
  /** Result label — managed `siteName` or external `siteId`. */
  label: string;
  /** Which transport carries this site's signed health.check. */
  transport: SweepTransport;
  /** The signed round-trip; both variants persist `connectorVersion` on success. */
  check: () => Promise<ConnectorHealth>;
}

export interface HealthSweepSiteResult {
  /** Managed link's siteName, or external link's siteId. */
  site: string;
  /** Transport the check ran over — lets the caller see both families were swept. */
  transport: SweepTransport;
  ok: boolean;
  /** Rejection reason or thrown-error message when the check did not pass. */
  reason?: string;
  roundtripMs?: number;
}

export interface HealthSweepSummary {
  ranAt: string;
  /** Number of links the sweep attempted (managed + external). */
  total: number;
  passed: number;
  failed: number;
  /** Per-transport attempt counts, for observability into external coverage. */
  managedTotal: number;
  externalTotal: number;
  results: HealthSweepSiteResult[];
}

/** Active, fingerprint-confirmed §5.1 managed links — swept over k8s exec. */
function isSweepableManaged(site: ExternalSiteRecord): boolean {
  return Boolean(site.managed) && Boolean(site.siteName) && site.state === "active" && site.fingerprintConfirmed;
}

/** Active, fingerprint-confirmed §5 external links — swept over HTTPS. */
function isSweepableExternal(site: ExternalSiteRecord): boolean {
  return !site.managed && site.state === "active" && site.fingerprintConfirmed;
}

function buildTargets(sites: ExternalSiteRecord[]): SweepTarget[] {
  const managed = sites.filter(isSweepableManaged).map((site): SweepTarget => {
    const siteName = site.siteName as string;
    return { label: siteName, transport: "exec", check: () => connectorHealthCheck(siteName) };
  });
  const external = sites.filter(isSweepableExternal).map((site): SweepTarget => ({
    label: site.siteId,
    transport: "https",
    check: () => externalConnectorHealthCheck(site.siteId),
  }));
  return [...managed, ...external];
}

export async function runHealthSweep(): Promise<HealthSweepSummary> {
  const sites = await listExternalSites();
  const targets = buildTargets(sites);

  // Sweep every target CONCURRENTLY. Each check bounds its own round-trip
  // (COMMAND_TIMEOUT_MS on exec; the fetch timeout on HTTPS), so running them
  // sequentially made total wall-time N× a timeout — a few unreachable links
  // pushed the sweep past the CronJob's `--max-time 300` and failed it hourly.
  // allSettled keeps each site isolated (one failure never rejects the batch)
  // and caps wall-time at ~one timeout regardless of site count — so a dead
  // external endpoint costs one slot, not the whole batch.
  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<HealthSweepSiteResult> => {
      try {
        const health = await target.check();
        return {
          site: target.label,
          transport: target.transport,
          ok: health.ok,
          roundtripMs: health.roundtripMs,
          ...(health.rejectedReason ? { reason: health.rejectedReason } : {}),
        };
      } catch (err) {
        // A per-site failure (pod down, quarantined link, unreachable external
        // endpoint, tamper) is logged and recorded, but the sweep carries on.
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[wordpress:iwsl] health sweep for ${target.label} (${target.transport}) failed:`, reason);
        return { site: target.label, transport: target.transport, ok: false, reason };
      }
    }),
  );

  const results: HealthSweepSiteResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          site: targets[i].label,
          transport: targets[i].transport,
          ok: false,
          reason: String(outcome.reason),
        },
  );

  const passed = results.filter((r) => r.ok).length;
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    managedTotal: results.filter((r) => r.transport === "exec").length,
    externalTotal: results.filter((r) => r.transport === "https").length,
    results,
  };
}
