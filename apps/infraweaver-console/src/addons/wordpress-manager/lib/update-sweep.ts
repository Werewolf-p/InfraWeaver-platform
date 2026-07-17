import "server-only";
import { buildConnectorPackage } from "./connector-package";
import { listExternalSites } from "./iwsl-link-store";
import { updateConnectorPlugin } from "./iwsl-managed-ops";

/**
 * Fleet-wide Connector update (§5.1 maintenance). Runs the same in-place
 * `plugin install --force` the operator triggers per site from the connector
 * tab, but across every enrolled managed link at once — so one console push
 * lands the bundled Connector on all in-cluster sites without visiting each.
 *
 * Managed links ONLY. `updateConnectorPlugin` drives the site's pod over the
 * k8s-exec transport; external (§5) sites have no exec channel and are updated
 * manually — see docs/iwsl-signed-plugin-update.md for why a signed
 * `plugin.update` method is deferred, not shipped here. Pending links are
 * skipped: they have not finished enrollment, so a forced reinstall would race
 * the enroll flow for no gain.
 *
 * Each site is isolated in its own try/catch and the batch runs CONCURRENTLY
 * with Promise.allSettled — one unreachable pod (or a 120s install timeout)
 * must not abort or serialise the rest (mirrors runHealthSweep).
 */

export interface ConnectorUpdateSiteResult {
  /** The WordPress-manager site name (managed link's siteName). */
  site: string;
  ok: boolean;
  /**
   * Running Connector version after the update, read back over a signed
   * health.check. Null when the link is not commandable (e.g. quarantined) so
   * the reinstall happened but no signed round-trip confirmed the version.
   */
  version?: string | null;
  /** Thrown-error message when the update did not complete. */
  reason?: string;
}

export interface ConnectorUpdateSweepSummary {
  ranAt: string;
  /** Bundled Connector version this sweep pushed (from the console image). */
  targetVersion: string;
  /** Number of enrolled managed links the sweep attempted. */
  total: number;
  updated: number;
  failed: number;
  results: ConnectorUpdateSiteResult[];
}

export async function runConnectorUpdateSweep(): Promise<ConnectorUpdateSweepSummary> {
  const [sites, pkg] = await Promise.all([listExternalSites(), buildConnectorPackage()]);
  const targets = sites.filter(
    (site) => site.managed && site.siteName && site.state !== "pending",
  );

  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<ConnectorUpdateSiteResult> => {
      const siteName = target.siteName as string;
      try {
        const { version } = await updateConnectorPlugin(siteName);
        return { site: siteName, ok: true, version };
      } catch (err) {
        // A per-site failure (pod down, plugin dir not writable, exec timeout)
        // is logged and recorded, but the sweep carries on for the rest.
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[wordpress:iwsl] connector update for ${siteName} failed:`, reason);
        return { site: siteName, ok: false, reason };
      }
    }),
  );

  const results: ConnectorUpdateSiteResult[] = settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { site: targets[i].siteName as string, ok: false, reason: String(outcome.reason) },
  );

  const updated = results.filter((r) => r.ok).length;
  return {
    ranAt: new Date().toISOString(),
    targetVersion: pkg.version,
    total: results.length,
    updated,
    failed: results.length - updated,
    results,
  };
}
