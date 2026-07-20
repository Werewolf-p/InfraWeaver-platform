import "server-only";
import { mapWithConcurrency } from "../concurrency";
import { writeSitePanelSnapshots, type PanelSnapshotWriteEntry } from "./panel-snapshot";
import type { ManagePanelId } from "./capabilities";
import type { ManageOverview } from "./types";
import type { InventoryData } from "./probes/inventory";
import type { UpdatesData } from "./probes/updates";
import type { MediaData } from "./probes/media";
import type { DataPanelData } from "./probes/data";
import type { PeopleData } from "./probes/people";

/**
 * The authoritative fields of a site's overview that let us prove a panel capture
 * is a degenerate (empty-exec) all-zero rather than legitimately empty. Every
 * value here is read by the LIGHT overview probe, which succeeds on sites whose
 * heavier per-panel execs (a `du` over a 1 GB uploads tree, `db size --tables`)
 * flake to empty under sweep concurrency — the exact split that made one big site
 * show all zeros while its overview stayed correct.
 */
export type OverviewCrossSignal = Pick<
  ManageOverview,
  "totalPlugins" | "activePlugins" | "uploadsMb" | "dbSizeMb" | "userCount"
>;

/** `> 0` when the overview carries a concrete positive scalar (null/undefined ⇒ no signal). */
function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && value > 0;
}

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
 * proves is WRONG (a degenerate/empty exec), so it must not overwrite — nor be
 * served from — the last good snapshot.
 *
 * A panel is only rejectable when the overview carries an authoritative cross-signal
 * that CONTRADICTS the empty capture: the overview counts installed plugins yet the
 * inventory found none; it measured a 1 GB uploads tree yet the media panel reads
 * 0 MB and 0 attachments; it measured a 46 MB database yet the data panel reads 0
 * tables; it counted N accounts yet the people panel returns none. When the overview
 * has NO positive signal for a panel (a genuinely empty site, or an older overview
 * snapshot missing the newer `userCount` field) the empty capture is accepted — an
 * empty result there may be legitimate and there is nothing to contradict it. This
 * is the single defence, shared by the sweep write, the interactive force write, and
 * the durable read, so a demonstrably-wrong all-zero panel can be neither stored nor
 * served. Pure and total.
 */
export function isDegenerateCapture(
  panelId: ManagePanelId,
  data: unknown,
  overview?: OverviewCrossSignal,
): boolean {
  if (!overview) return false;

  switch (panelId) {
    case "inventory": {
      const inv = data as Partial<InventoryData> | null;
      const plugins = Array.isArray(inv?.plugins) ? inv!.plugins : [];
      // Overview counts installed plugins, but the capture found none → empty exec.
      if (overview.totalPlugins > 0 && plugins.length === 0) return true;
      // Overview counts active plugins, but the capture counts none active → wrong.
      if (overview.activePlugins > 0 && (inv?.activePlugins ?? 0) === 0) return true;
      return false;
    }

    case "updates": {
      const upd = data as Partial<UpdatesData> | null;
      // The updates panel re-reads the full installed-plugin list for its
      // total/auto-update counts; reading zero while the overview counts some is the
      // same empty-exec signature.
      if (overview.totalPlugins > 0 && (upd?.totalPlugins ?? 0) === 0) return true;
      return false;
    }

    case "media": {
      const m = data as Partial<MediaData> | null;
      // Overview measured a non-empty uploads tree, but the panel read nothing:
      // both the `du` size and the attachment count came back empty → dead exec.
      const empty = !positive(m?.uploadsMb) && (m?.total ?? 0) === 0;
      return positive(overview.uploadsMb) && empty;
    }

    case "data": {
      const d = data as Partial<DataPanelData> | null;
      // Overview measured a non-empty database, but the panel read no size AND no
      // tables → the `db size` execs died rather than a truly empty database.
      const empty = !positive(d?.totalMb) && (d?.tables?.length ?? 0) === 0;
      return positive(overview.dbSizeMb) && empty;
    }

    case "people": {
      const p = data as Partial<PeopleData> | null;
      // Overview counted accounts, but the panel returned none → dead exec. (A real
      // WordPress site always has at least one admin, so a positive overview count
      // with an empty people capture is never legitimate.)
      const empty = (p?.total ?? 0) === 0 && (p?.users?.length ?? 0) === 0;
      return positive(overview.userCount) && empty;
    }

    default:
      return false;
  }
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
  overview?: OverviewCrossSignal,
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
