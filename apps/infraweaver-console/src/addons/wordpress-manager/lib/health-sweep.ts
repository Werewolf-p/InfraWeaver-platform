import "server-only";
import { listExternalSites } from "./iwsl-link-store";
import { connectorHealthCheck } from "./iwsl-managed-ops";

/**
 * Server-driven connector health sweep (§12.5). Runs the same signed
 * `health.check` round-trip the operator triggers by hand, but across every
 * commandable managed link at once — so `lastHealth` stays fresh regardless of
 * who has a browser open. Invoked hourly by the health-sweep CronJob.
 *
 * Only §5.1 managed links that are active + fingerprint-confirmed are swept:
 * connectorHealthCheck runs over the k8s-exec transport and requires a
 * commandable link, so anything else would just fail-closed. Each site is
 * isolated in its own try/catch — one unreachable pod must not abort the rest.
 */

export interface HealthSweepSiteResult {
  /** The WordPress-manager site name (managed link's siteName). */
  site: string;
  ok: boolean;
  /** Rejection reason or thrown-error message when the check did not pass. */
  reason?: string;
  roundtripMs?: number;
}

export interface HealthSweepSummary {
  ranAt: string;
  /** Number of managed links the sweep attempted. */
  total: number;
  passed: number;
  failed: number;
  results: HealthSweepSiteResult[];
}

export async function runHealthSweep(): Promise<HealthSweepSummary> {
  const sites = await listExternalSites();
  const targets = sites.filter(
    (site) => site.managed && site.siteName && site.state === "active" && site.fingerprintConfirmed,
  );

  // Sweep every site CONCURRENTLY. connectorHealthCheck already bounds each
  // round-trip at COMMAND_TIMEOUT_MS (60s); running them sequentially made the
  // total wall-time N×60s, so a few unreachable connectors pushed the sweep past
  // the CronJob's `--max-time 300`, failing the job hourly (BackoffLimitExceeded).
  // allSettled keeps each site isolated (one failure never rejects the batch) and
  // caps wall-time at ~one command timeout regardless of site count.
  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<HealthSweepSiteResult> => {
      const siteName = target.siteName as string;
      try {
        const health = await connectorHealthCheck(siteName);
        return {
          site: siteName,
          ok: health.ok,
          roundtripMs: health.roundtripMs,
          ...(health.rejectedReason ? { reason: health.rejectedReason } : {}),
        };
      } catch (err) {
        // A per-site failure (pod down, quarantined link, tamper) is logged and
        // recorded, but the sweep carries on for the remaining sites.
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[wordpress:iwsl] health sweep for ${siteName} failed:`, reason);
        return { site: siteName, ok: false, reason };
      }
    }),
  );

  const results: HealthSweepSiteResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { site: targets[i].siteName as string, ok: false, reason: String(outcome.reason) },
  );

  const passed = results.filter((r) => r.ok).length;
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
