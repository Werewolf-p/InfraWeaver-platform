import "server-only";
import { assertValidSiteId } from "../naming";
import { siteExists } from "../provision";
import { execInWpPod } from "../k8s-exec";
import { getManagedLink } from "../iwsl-managed";
import { AddonHttpError, SiteNotFoundError } from "../errors";
import {
  getPanelDef,
  isManagePanelId,
  resolveCapabilities,
  type ManageCapabilityId,
  type ManagePanelId,
} from "./capabilities";
import { requireRunningWpPod } from "./overview";
import { WP, activePluginSlugs } from "./wp-probe";
import { withCache, panelKey, invalidateManageCache, type Cached } from "./snapshot-cache";
import { readSitePanelSnapshot, writeSitePanelSnapshot } from "./panel-snapshot";
import { readSiteSnapshot } from "./site-snapshot";
import { runPanelCapture, isDegenerateCapture, type OverviewCrossSignal } from "./panel-capture";
import type { PanelProbe, PanelProbeContext } from "./probes/contract";
import { updatesProbe } from "./probes/updates";
import { inventoryProbe } from "./probes/inventory";
import { contentProbe } from "./probes/content";
import { mediaProbe } from "./probes/media";
import { peopleProbe } from "./probes/people";
import { dataProbe } from "./probes/data";
import { healthProbe } from "./probes/health";
import { securityProbe } from "./probes/security";
import { performanceProbe } from "./probes/performance";
import { resourcesProbe } from "./probes/resources";
import { alertsProbe } from "./probes/alerts";
import { logsProbe } from "./probes/logs";
import { storeProbe } from "./probes/store";
import { formsProbe } from "./probes/forms";
import { backupsProbe } from "./probes/backups";
import { stagingProbe } from "./probes/staging";
import { emailProbe } from "./probes/email";
import { audienceProbe } from "./probes/audience";
import { auditProbe } from "./probes/audit";
import { uptimeProbe } from "./probes/uptime";
import { metricsProbe } from "./probes/metrics";
import { clientsProbe } from "./probes/clients";

/**
 * Dispatch a Manage-panel data request to its probe over the secure in-pod exec
 * path. Resolves the site's running pod and current capabilities once, enforces
 * the panel's capability gate (a gated panel on a site that lacks the plugin is
 * refused with 409, never answered with empty data), then runs the probe.
 */

const PROBES: readonly PanelProbe[] = [
  updatesProbe,
  inventoryProbe,
  contentProbe,
  mediaProbe,
  peopleProbe,
  dataProbe,
  healthProbe,
  securityProbe,
  performanceProbe,
  resourcesProbe,
  alertsProbe,
  logsProbe,
  storeProbe,
  formsProbe,
  backupsProbe,
  stagingProbe,
  emailProbe,
  audienceProbe,
  auditProbe,
  uptimeProbe,
  metricsProbe,
  clientsProbe,
];

const PROBE_BY_ID = new Map<ManagePanelId, PanelProbe>(PROBES.map((probe) => [probe.id, probe]));

/** Active plugin slugs (lowercased) for capability resolution — cheap dedicated read. */
async function readActivePlugins(pod: string): Promise<Set<string>> {
  const { stdout } = await execInWpPod(pod, `${WP} plugin list --status=active --field=name --format=json`).catch(
    () => ({ stdout: "[]" }),
  );
  return activePluginSlugs(stdout);
}

export async function getManagePanel(site: string, panelId: string): Promise<unknown> {
  assertValidSiteId(site);
  if (!isManagePanelId(panelId)) throw new AddonHttpError("Unknown panel", 404);
  const def = getPanelDef(panelId);
  const probe = PROBE_BY_ID.get(panelId);
  if (!def || !probe) throw new AddonHttpError("Panel is not available yet", 501);

  if (!(await siteExists(site))) throw new SiteNotFoundError(site);
  const pod = await requireRunningWpPod(site);
  const [activePlugins, managed] = await Promise.all([
    readActivePlugins(pod),
    getManagedLink(site).catch(() => null),
  ]);
  const connectorActive = managed?.state === "active" && managed.fingerprintConfirmed === true;
  const capabilities = resolveCapabilities({ activePlugins, connectorActive: !!connectorActive });

  // Enforce the panel's capability gate — mirrors the client's tab gating so a
  // hand-crafted request can't reach a probe for an uninstalled plugin.
  const required: ManageCapabilityId | undefined = probe.requiresCapability ?? def.requires?.capability;
  if (required && !capabilities[required]) {
    throw new AddonHttpError(`This panel needs ${def.requires?.label ?? required} — it is not active on this site`, 409);
  }

  const ctx: PanelProbeContext = {
    site,
    pod,
    exec: (script, opts) => execProbe(pod, script, opts),
    capabilities,
    managed,
  };
  return probe.fetch(ctx);
}

/**
 * Probe exec with retry-on-empty. A wp-cli exec into a slow/loaded pod
 * occasionally returns exit-0 with NO output at all (the exec stream closes
 * early), which a probe would otherwise parse as "0 results" and cache as wrong
 * data — the "site shows all 0s" bug. Total silence (empty stdout AND stderr) is
 * treated as a transient flake and retried a couple times with a short backoff.
 * A genuinely-empty command still returns empty after the retries (a few hundred
 * ms slower, correct); any command that produced stderr or a non-zero exit is
 * never retried here (the latter already threw in execInWpPod).
 */
async function execProbe(
  pod: string,
  script: string,
  opts?: Parameters<typeof execInWpPod>[2],
): Promise<{ stdout: string; stderr: string }> {
  const MAX_ATTEMPTS = 3;
  let last = { stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await execInWpPod(pod, script, opts);
    if (last.stdout.trim() !== "" || last.stderr.trim() !== "") return last;
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
  }
  return last;
}

/**
 * The site's authoritative overview scalars from the DURABLE overview snapshot —
 * the cross-signal the degenerate-capture check needs. Read from the ConfigMap
 * store (no wp-cli), best-effort: any miss returns undefined, which simply disables
 * the cross-check for this read (never a false rejection). This is what lets a panel
 * read distrust a stored all-zero snapshot that the site overview proves is wrong,
 * and refuse to persist a fresh one, WITHOUT a live overview round-trip on the hot
 * path.
 */
async function readOverviewCrossSignal(site: string): Promise<OverviewCrossSignal | undefined> {
  const snap = await readSiteSnapshot(site).catch(() => null);
  if (!snap) return undefined;
  const o = snap.overview;
  return {
    totalPlugins: o.totalPlugins,
    activePlugins: o.activePlugins,
    uploadsMb: o.uploadsMb,
    dbSizeMb: o.dbSizeMb,
    userCount: o.userCount ?? null,
  };
}

/** How long a panel snapshot is served without a background refresh. */
const PANEL_FRESH_MS = 25_000;

/**
 * Panel data through the stale-while-revalidate cache — a tab reopened within the
 * freshness window paints from the snapshot instantly and reconciles behind it.
 */
export function getCachedManagePanel(site: string, panelId: string): Promise<Cached<unknown>> {
  return withCache(panelKey(site, panelId), PANEL_FRESH_MS, () => getManagePanel(site, panelId));
}

/**
 * Beyond this age a durable panel snapshot is flagged `stale` so the UI can hint
 * "last refreshed a while ago". Sized to the hourly sweep cadence plus slack —
 * matches the overview store's staleness window.
 */
const PANEL_SNAPSHOT_STALE_MS = 90 * 60 * 1000;

/**
 * The page's per-panel read. Prefers the DURABLE cross-replica snapshot so a cold
 * open — a fresh replica, a restart, a first-ever view — paints instantly from the
 * last sweep instead of blocking on a wp-cli round-trip. Only pulls live when the
 * caller forces a renew (`force`), the panel has never been swept, OR the stored
 * snapshot is a degenerate all-zero that the site overview proves is wrong — the
 * self-heal that unsticks a big/slow site whose earlier sweep captured empty execs.
 * A fresh pull is written back only when it is NOT itself degenerate, so a live pull
 * can replace bad data with good but never good with bad. The panel's capability
 * gate is enforced on the live path (getManagePanel).
 */
export async function loadManagePanel(
  site: string,
  panelId: string,
  opts: { force?: boolean } = {},
): Promise<Cached<unknown>> {
  assertValidSiteId(site);
  if (!isManagePanelId(panelId)) throw new AddonHttpError("Unknown panel", 404);

  // The site overview's authoritative scalars — used to reject a demonstrably-wrong
  // empty capture on both the read (don't serve it) and the write (don't persist it).
  const crossSignal = await readOverviewCrossSignal(site);

  if (!opts.force) {
    const durable = await readSitePanelSnapshot(site, panelId).catch(() => null);
    // Serve the snapshot only when the overview does NOT prove it degenerate. A
    // stored all-zero that contradicts the overview is skipped so we fall through to
    // a live pull instead of painting known-wrong zeros.
    if (durable && !isDegenerateCapture(panelId, durable.data, crossSignal)) {
      return {
        value: durable.data,
        cachedAt: durable.at,
        stale: Date.now() - durable.at > PANEL_SNAPSHOT_STALE_MS,
      };
    }
  }

  if (opts.force) invalidateManageCache(site);
  const cached = await getCachedManagePanel(site, panelId);
  // Persist durably so the next cold/cross-replica open is instant — but never
  // overwrite a good snapshot with a fresh pull the overview proves is a degenerate
  // empty (a slow pod can flake mid-force too). Best-effort: a snapshot-store blip
  // must never fail a read that already has fresh data.
  if (isDegenerateCapture(panelId, cached.value, crossSignal)) {
    console.warn(
      `[wordpress] Manage panel ${site}/${panelId} live pull is degenerate against the overview — not persisted (kept last good)`,
    );
  } else {
    await writeSitePanelSnapshot(site, panelId, cached.value, cached.cachedAt).catch((err) => {
      console.warn(
        `[wordpress] durable panel snapshot write for ${site}/${panelId} failed:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
  return cached;
}

/**
 * Sweep-side capture: live-pull the given panels for a site and persist the
 * successes into the site's durable panel ConfigMap in ONE batch write. Per-panel
 * failure-isolated so one broken probe never blanks the rest; a panel that fails —
 * or that comes back degenerately empty against the overview — keeps its last good
 * snapshot. Called by the hourly site sweep (and the init warm) with the site's
 * AVAILABLE panel ids; pass the site's `overview` so the capture core can reject a
 * demonstrably-wrong empty result. An empty panel list is a no-op.
 *
 * The concurrency limit + degenerate-rejection live in runPanelCapture (unit-tested
 * with an injected fetcher); here we simply wire in the real getManagePanel.
 */
export function capturePanelSnapshots(
  site: string,
  panelIds: readonly ManagePanelId[],
  overview?: OverviewCrossSignal,
  at = Date.now(),
): Promise<{ captured: number; failed: number }> {
  return runPanelCapture(getManagePanel, site, panelIds, overview, at);
}
