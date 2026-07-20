import "server-only";
import { buildConnectorPackage } from "./connector-package";
import { listExternalSites } from "./iwsl-link-store";
import { updateConnectorPlugin } from "./iwsl-managed-ops";
import { isValidSiteId } from "./naming";
import { mapWithConcurrency } from "./concurrency";

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
 * Each site is isolated in its own try/catch — one unreachable pod (or a 120s
 * install timeout) must not abort the rest. Unlike runHealthSweep, the batch is
 * NOT fired all-at-once: it runs through a bounded-concurrency pool and honours
 * a per-run cap. Every per-site update does several read-modify-writes on the
 * single IWSL ConfigMap (allocateSeq + the connector-version persist), so an
 * unbounded fleet burst would blow mutateExternalSites' 409-retry budget and
 * surface a lost persist race as a false "update failed" (the 409 race). The
 * bounded pool keeps CM contention inside the retry window; the cap bounds how
 * many sites one push can touch (blast radius) when a plugin build is bad.
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
  /** Number of enrolled managed links the sweep attempted THIS run (after the cap). */
  total: number;
  updated: number;
  failed: number;
  /**
   * Enrolled managed links left untouched this run because the per-run cap was
   * hit. Non-zero means "run the sweep again to continue" — those sites keep
   * their current Connector until the next push.
   */
  deferred: number;
  results: ConnectorUpdateSiteResult[];
}

export interface ConnectorUpdateSweepOptions {
  /**
   * Blast-radius cap: the most enrolled links one run will reinstall. Enrolled
   * links beyond this are deferred to the next run. Defaults to
   * DEFAULT_MAX_PER_RUN; the handler leaves it unset.
   */
  maxPerRun?: number;
  /**
   * Optional selection (the fleet bulk-actions UI passes it): restrict the sweep
   * to these managed-site names. Each is validated with `isValidSiteId`; unknown
   * or unenrolled names are silently ignored. Undefined ⇒ every enrolled managed
   * link, exactly as before. An explicitly empty array selects nothing.
   */
  sites?: readonly string[];
}

/**
 * Default per-run cap (§5.1 blast radius). Generous enough that a normal fleet
 * finishes in one push, low enough that a runaway/large fleet can't force-push a
 * (possibly bad) plugin build to an unbounded number of pods in a single run.
 */
const DEFAULT_MAX_PER_RUN = 25;

/**
 * How many per-site updates run concurrently. Bounded so the fleet doesn't burst
 * its allocateSeq + connector-version writes onto the one IWSL ConfigMap in
 * lockstep and exhaust mutateExternalSites' retry budget (the 409 race). Small
 * enough to keep CM contention inside that retry window; large enough that a
 * handful of sites still complete a run quickly. Installs dominate wall-time
 * (~120s each), so a low fan-out costs little.
 */
const SWEEP_CONCURRENCY = 4;

export async function runConnectorUpdateSweep(
  options: ConnectorUpdateSweepOptions = {},
): Promise<ConnectorUpdateSweepSummary> {
  const [records, pkg] = await Promise.all([listExternalSites(), buildConnectorPackage()]);
  let enrolled = records.filter(
    (site) => site.managed && site.siteName && site.state !== "pending",
  );

  // Optional selection: restrict to the requested, valid, enrolled site names. An
  // undefined selection keeps the all-sites behaviour; unknown/invalid names are
  // dropped rather than erroring the whole sweep.
  if (options.sites) {
    const requested = new Set(options.sites.filter((s) => isValidSiteId(s)));
    enrolled = enrolled.filter((site) => requested.has(site.siteName as string));
  }

  const maxPerRun = Math.max(1, Math.floor(options.maxPerRun ?? DEFAULT_MAX_PER_RUN));
  const targets = enrolled.slice(0, maxPerRun);
  const deferred = enrolled.length - targets.length;
  if (deferred > 0) {
    console.warn(
      `[wordpress:iwsl] connector update sweep capped at ${maxPerRun}/${enrolled.length} sites — ${deferred} deferred to the next run`,
    );
  }

  const results = await mapWithConcurrency(
    targets,
    SWEEP_CONCURRENCY,
    async (target): Promise<ConnectorUpdateSiteResult> => {
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
    },
  );

  const updated = results.filter((r) => r.ok).length;
  return {
    ranAt: new Date().toISOString(),
    targetVersion: pkg.version,
    total: results.length,
    updated,
    failed: results.length - updated,
    deferred,
    results,
  };
}
