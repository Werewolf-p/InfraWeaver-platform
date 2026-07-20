import "server-only";
import { listSites } from "../provision";
import { isValidSiteId } from "../naming";
import { getManageOverview } from "./overview";
import { capturePanelSnapshots } from "./panel-data";
import { writeSiteSnapshots, type SnapshotWriteEntry } from "./site-snapshot";
import type { ManagePanelId } from "./capabilities";
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
  /** Available panels captured durably for this site (probe succeeded). */
  panelsCaptured?: number;
  /** Available panels whose probe failed this sweep (kept their last good snapshot). */
  panelsFailed?: number;
}

export interface SiteSweepSummary {
  ranAt: string;
  /** Sites the sweep attempted (every provisioned site). */
  total: number;
  /** Sites whose overview was pulled and persisted durably. */
  captured: number;
  failed: number;
  /** Total panel snapshots captured across every swept site. */
  panelsCaptured: number;
  /** Total available-panel probes that failed across the fleet. */
  panelsFailed: number;
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

/** The available (gate-satisfied) panel ids of an overview — the ones worth capturing. */
function availablePanelIds(overview: ManageOverview): ManagePanelId[] {
  return overview.panels.filter((p) => p.available).map((p) => p.id);
}

/**
 * Sweep an explicit site-id list: live-pull each overview, batch-persist the
 * successes, then capture each captured site's AVAILABLE panels into its durable
 * per-site panel snapshot. Split from runSiteSnapshotSweep so the isolation/summary
 * logic is unit-testable with a stub site list, without a cluster.
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

  // Warm each captured site's per-panel durable snapshots. Per-site isolated so one
  // site's panel failures never abort another's; the counts fold back per result.
  // The site's overview is passed through so the capture core can reject a
  // degenerate (all-zero) panel that contradicts the overview's authoritative counts
  // instead of overwriting the last good snapshot with it.
  const panelOutcomes = await Promise.allSettled(
    toPersist.map(async ({ site, overview }) => ({
      site,
      ...(await capturePanelSnapshots(site, availablePanelIds(overview), overview)),
    })),
  );
  const panelCounts = new Map<string, { captured: number; failed: number }>();
  for (const outcome of panelOutcomes) {
    if (outcome.status === "fulfilled") {
      panelCounts.set(outcome.value.site, { captured: outcome.value.captured, failed: outcome.value.failed });
    }
  }
  for (const result of results) {
    const counts = panelCounts.get(result.site);
    if (counts) {
      result.panelsCaptured = counts.captured;
      result.panelsFailed = counts.failed;
    }
  }

  const captured = toPersist.length;
  return {
    ranAt: new Date().toISOString(),
    total: results.length,
    captured,
    failed: results.length - captured,
    panelsCaptured: [...panelCounts.values()].reduce((sum, c) => sum + c.captured, 0),
    panelsFailed: [...panelCounts.values()].reduce((sum, c) => sum + c.failed, 0),
    results,
  };
}

/**
 * The scheduled/operator entry point. With no argument it sweeps EVERY provisioned
 * site (the hourly cron, unchanged). With an explicit `sites` selection (the fleet
 * bulk-actions UI) it restricts the warm to those provisioned sites: each is
 * validated with `isValidSiteId`, and names that don't match a provisioned site are
 * ignored (an empty/unknown selection simply sweeps nothing).
 */
export async function runSiteSnapshotSweep(sites?: readonly string[]): Promise<SiteSweepSummary> {
  const provisioned = (await listSites()).map((s) => s.site).filter((s) => s.length > 0);
  if (!sites) return sweepSites(provisioned);
  const requested = new Set(sites.filter((s) => isValidSiteId(s)));
  return sweepSites(provisioned.filter((s) => requested.has(s)));
}

/**
 * Warm ONE site's durable snapshots immediately — the init/enroll path, so a newly
 * available site paints real data at once instead of showing zeros until the next
 * scheduled sweep. Delegates to the same isolated sweep machinery (live overview
 * pull → durable persist → per-panel capture with degenerate-rejection). Never
 * throws: `sweepSites` folds every failure into its summary, so an unreachable pod
 * yields an `ok:false` result rather than a rejection — a warm error must never
 * block or fail the enrollment that triggered it.
 */
export async function warmSiteSnapshot(site: string): Promise<SiteSweepResult> {
  const summary = await sweepSites([site]);
  return summary.results[0] ?? { site, ok: false, reason: "no result" };
}
