import "server-only";
import { mapWithConcurrency } from "../concurrency";
import { writeSitePanelSnapshots, type PanelSnapshotWriteEntry } from "./panel-snapshot";
import type { ManagePanelId } from "./capabilities";
import type { ManageOverview } from "./types";
import type { InventoryData } from "./probes/inventory";
import type { UpdatesData } from "./probes/updates";

/**
 * Sweep-side panel capture core, split out of panel-data.ts so the concurrency +
 * degenerate-rejection logic is unit-testable with an injected fetcher (no cluster,
 * no wp-cli). panel-data.ts wires `fetchPanel` to the real getManagePanel.
 *
 * TWO defences against the "site shows all 0s" durable-snapshot bug:
 *
 *  (a) BOUNDED CONCURRENCY. A slow pod fired ~17 simultaneous execs starts
 *      returning successful-but-EMPTY output (no thrown error) that a probe parses
 *      as "0 items". A small worker pool keeps the pod responsive so each probe
 *      reads real data instead of a degenerate empty result.
 *
 *  (b) CROSS-CHECK AGAINST THE OVERVIEW. Even with (a), a single exec can come back
 *      empty. The overview for the same site carries authoritative counts
 *      (totalPlugins/activePlugins). When the overview proves the site is non-empty
 *      but a capture came back empty, the capture is REJECTED — treated as a failure
 *      (counted in `failed`, kept last-good), never stored. The rule: never
 *      overwrite a good snapshot with a demonstrably-wrong empty one.
 */

/** How many per-panel captures run against one pod at once — see defence (a). */
const PANEL_CAPTURE_CONCURRENCY = 3;

/**
 * True when a freshly-captured panel value is empty in a way the site overview
 * proves is WRONG (a degenerate/empty exec), so it must not overwrite the last good
 * snapshot. Only panels with an authoritative overview cross-signal can be rejected;
 * panels with no such signal (people/content/media/…) are always accepted here — an
 * empty capture there may be legitimately empty, and there is nothing to contradict
 * it. Pure and total.
 */
export function isDegenerateCapture(
  panelId: ManagePanelId,
  data: unknown,
  overview?: Pick<ManageOverview, "totalPlugins" | "activePlugins">,
): boolean {
  if (!overview) return false;

  if (panelId === "inventory") {
    const inv = data as Partial<InventoryData> | null;
    const plugins = Array.isArray(inv?.plugins) ? inv!.plugins : [];
    // Overview counts installed plugins, but the capture found none → empty exec.
    if (overview.totalPlugins > 0 && plugins.length === 0) return true;
    // Overview counts active plugins, but the capture counts none active → wrong.
    if (overview.activePlugins > 0 && (inv?.activePlugins ?? 0) === 0) return true;
    return false;
  }

  if (panelId === "updates") {
    const upd = data as Partial<UpdatesData> | null;
    // The updates panel re-reads the full installed-plugin list for its
    // total/auto-update counts; reading zero while the overview counts some is the
    // same empty-exec signature.
    if (overview.totalPlugins > 0 && (upd?.totalPlugins ?? 0) === 0) return true;
    return false;
  }

  return false;
}

/** Outcome of one panel capture, before the batch write. */
type PanelCaptureOutcome =
  | { readonly ok: true; readonly entry: PanelSnapshotWriteEntry }
  | { readonly ok: false; readonly panel: ManagePanelId; readonly reason: string };

/**
 * Capture `panelIds` for `site` through `fetchPanel`, at most
 * PANEL_CAPTURE_CONCURRENCY in flight, rejecting degenerate captures against the
 * optional `overview`, and persist the survivors in ONE batch write. Per-panel
 * failure-isolated: one broken (or degenerate) probe never blanks the rest, and a
 * rejected panel keeps its last good snapshot. An empty panel list is a no-op.
 */
export async function runPanelCapture(
  fetchPanel: (site: string, panelId: ManagePanelId) => Promise<unknown>,
  site: string,
  panelIds: readonly ManagePanelId[],
  overview?: Pick<ManageOverview, "totalPlugins" | "activePlugins">,
  at = Date.now(),
): Promise<{ captured: number; failed: number }> {
  if (panelIds.length === 0) return { captured: 0, failed: 0 };

  const outcomes = await mapWithConcurrency(
    panelIds,
    PANEL_CAPTURE_CONCURRENCY,
    async (panelId): Promise<PanelCaptureOutcome> => {
      try {
        const data = await fetchPanel(site, panelId);
        if (isDegenerateCapture(panelId, data, overview)) {
          return {
            ok: false,
            panel: panelId,
            reason: "degenerate empty capture — contradicts the site overview; kept last good snapshot",
          };
        }
        return { ok: true, entry: { panel: panelId, data } };
      } catch (err) {
        return { ok: false, panel: panelId, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  const entries: PanelSnapshotWriteEntry[] = [];
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      entries.push(outcome.entry);
    } else {
      failed += 1;
      console.warn(`[wordpress] Manage panel sweep ${site}/${outcome.panel} failed: ${outcome.reason}`);
    }
  }

  await writeSitePanelSnapshots(site, entries, at).catch((err) => {
    console.warn(
      `[wordpress] durable panel snapshot batch write for ${site} failed:`,
      err instanceof Error ? err.message : err,
    );
  });

  return { captured: entries.length, failed };
}
