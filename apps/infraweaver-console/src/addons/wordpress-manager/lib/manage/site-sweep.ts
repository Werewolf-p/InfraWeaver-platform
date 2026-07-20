import "server-only";
import { listSites } from "../provision";
import { getManageOverview } from "./overview";
import { writeSiteSnapshots, type SnapshotWriteEntry } from "./site-snapshot";
import type { ManageOverview } from "./types";

/**
 * Server-driven Manage-snapshot sweep — the hourly auto-pull that keeps the
 * durable per-site overview warm so the Manage page paints instantly.
 *
 * For every provisioned site it force-pulls the overview LIVE (the uncached
 * getManageOverview — three wp-cli execs), then persists every success in ONE
 * batch ConfigMap write (writeSiteSnapshots), which the page reads and the
 * metrics exporter renders numeric gauges from. Invoked hourly by the
 * manage-snapshot-sweep CronJob; also callable by an operator via the handler.
 *
 * Isolation mirrors the health sweep: every site runs under a single
 * Promise.allSettled, so one unreachable pod (SiteNotFound / pod-not-running)
 * becomes a recorded failure, never an aborted batch. A failed pull is NOT
 * persisted — the site keeps its last good snapshot rather than being blanked by
 * a transient blip.
 */

export interface SiteSweepResult {
  site: string;
  ok: boolean;
  /** Rejection reason when the live pull failed. */
  reason?: string;
}

export interface SiteSweepSummary {
  ranAt: string;
  /** Sites the sweep attempted (every provisioned site). */
  total: number;
  /** Sites whose overview was pulled and persisted durably. */
  captured: number;
  failed: number;
  results: SiteSweepResult[];
}

interface PulledSite {
  site: string;
  overview: ManageOverview;
}

/** Live-pull one site's overview, normalized to a result that never throws. */
async function pullOne(site: string): Promise<{ result: SiteSweepResult; pulled?: PulledSite }> {
  try {
    const overview = await getManageOverview(site);
    return { result: { site, ok: true }, pulled: { site, overview } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[wordpress] Manage snapshot sweep for ${site} failed:`, reason);
    return { result: { site, ok: false, reason } };
  }
}

/**
 * Sweep an explicit site-id list: live-pull each, batch-persist the successes.
 * Split from runSiteSnapshotSweep so the isolation/summary logic is unit-testable
 * with a stub site list, without a cluster.
 */
export async function sweepSites(sites: readonly string[]): Promise<SiteSweepSummary> {
  const settled = await Promise.allSettled(sites.map((site) => pullOne(site)));

  const results: SiteSweepResult[] = [];
  const toPersist: SnapshotWriteEntry[] = [];
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value.result);
      if (outcome.value.pulled) toPersist.push(outcome.value.pulled);
    } else {
      results.push({ site: sites[i], ok: false, reason: String(outcome.reason) });
    }
  });

  await writeSiteSnapshots(toPersist);

  const captured = toPersist.length;
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    captured,
    failed: results.length - captured,
    results,
  };
}

export async function runSiteSnapshotSweep(): Promise<SiteSweepSummary> {
  const sites = await listSites();
  return sweepSites(sites.map((s) => s.site).filter((s) => s.length > 0));
}
