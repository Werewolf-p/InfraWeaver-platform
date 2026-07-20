import "server-only";
import { invalidateManageCache } from "./snapshot-cache";
import { clearSitePanelSnapshots } from "./panel-snapshot";
import { clearSiteSnapshot } from "./site-snapshot";

/**
 * Invalidate EVERY cached Manage read for a site after a successful write action —
 * BOTH the per-replica in-memory SWR cache AND the durable, cross-replica ConfigMap
 * snapshots (per-panel + overview).
 *
 * Clearing only the in-memory tier (what the bare `invalidateManageCache` does) is
 * not enough: the next non-forced panel/overview read is served "durable-first" from
 * the ConfigMap snapshot, so a real mutation — activate / update / delete a plugin or
 * theme, change a user, edit a setting — would re-paint the STALE pre-mutation
 * snapshot and look like it "did nothing", even though wp-cli applied the change.
 * Dropping the durable snapshots here makes the follow-up read pull the post-mutation
 * state live and re-warm the snapshot with the truth.
 *
 * The durable clears are best-effort: the mutation has ALREADY succeeded by the time
 * this runs, and the in-memory clear already freshens this replica, so a ConfigMap
 * blip is logged and swallowed rather than failing the action the user just ran.
 */
export async function invalidateManageReadsAfterMutation(site: string): Promise<void> {
  // Synchronous, always safe — freshens the replica that served the mutation.
  invalidateManageCache(site);
  // Durable, cross-replica — the tier that actually caused the "did nothing" bug.
  await Promise.all([
    clearSitePanelSnapshots(site).catch((err) => {
      console.warn(
        `[wordpress] clearing durable panel snapshots for ${site} failed:`,
        err instanceof Error ? err.message : err,
      );
    }),
    clearSiteSnapshot(site).catch((err) => {
      console.warn(
        `[wordpress] clearing durable overview snapshot for ${site} failed:`,
        err instanceof Error ? err.message : err,
      );
    }),
  ]);
}
