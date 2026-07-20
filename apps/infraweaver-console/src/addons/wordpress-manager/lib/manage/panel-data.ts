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
import { withCache, panelKey, type Cached } from "./snapshot-cache";
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
    exec: (script, opts) => execInWpPod(pod, script, opts),
    capabilities,
    managed,
  };
  return probe.fetch(ctx);
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
