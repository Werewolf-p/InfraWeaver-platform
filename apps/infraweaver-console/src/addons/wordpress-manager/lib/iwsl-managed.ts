import "server-only";
import { AddonHttpError } from "./errors";
import type { ReleaseChannel } from "./channels";
import { execInWpPod } from "./k8s-exec";
import { findWpPodName, listSites } from "./provision";
import { buildConnectorPackage } from "./connector-package";
import {
  confirmFingerprint,
  createManagedSiteRecord,
  deleteExternalSite,
  issueBundle,
  listExternalSiteViews,
  verifyExternalSite,
  type ExternalSiteView,
} from "./iwsl-enrollment";
import {
  enrollBundleScript,
  extractProofJson,
  installConnectorScript,
  readEnrollProofScript,
  resetConnectorStateScript,
  uninstallConnectorScript,
} from "./iwsl-managed-commands";

/**
 * §5.1 automated enrollment for IW-provisioned cluster sites. Transport is
 * k8s exec into the site's own WordPress container — the crypto (bundle,
 * possession proof, WP-PK pinning) is byte-identical to manual enrollment;
 * only delivery changes. The fingerprint comparison is auto-confirmed: IW
 * controls both endpoints at enrollment time (bundle and proof travel over
 * the k8s API, never the network), so the §5 step-3 MITM window the manual
 * compare defends against does not exist here.
 */

const INSTALL_TIMEOUT_MS = 120_000;

async function requireRunningPod(site: string): Promise<string> {
  const pod = await findWpPodName(site);
  if (!pod) throw new AddonHttpError("The site's WordPress pod is not running yet", 503);
  return pod;
}

/** The managed link record for a site, or null when it was never enrolled. */
export async function getManagedLink(site: string): Promise<ExternalSiteView | null> {
  const views = await listExternalSiteViews();
  return views.find((v) => v.managed && v.siteName === site) ?? null;
}

/**
 * §5 — bind the link's canonical identity the instant enrollment completes by
 * firing one signed health.check, rather than leaving `canonicalUrl` null until
 * the first health sweep folds the self-reported URL into the record. Best-effort
 * by design: the link is already active and confirmed, so a transient failure
 * here only defers the identity bind to the next sweep — it must never fail the
 * enrollment that just succeeded. The import is dynamic on purpose: iwsl-managed-ops
 * statically imports `unlinkManagedSite` from this module, so a static import back
 * would close an import cycle (this mirrors provision.ts importing this module
 * dynamically for the same reason).
 */
async function bindIdentityViaHealthCheck(site: string): Promise<void> {
  try {
    const { connectorHealthCheck } = await import("./iwsl-managed-ops");
    await connectorHealthCheck(site);
  } catch (err) {
    console.warn(
      `[wordpress:iwsl] post-enroll health.check for ${site} failed; canonical URL binds on the next sweep:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * §5.1 — the instant enrollment completes the site has a running pod AND an active,
 * confirmed link, so its (now connector-gated) Manage panels are answerable for the
 * first time. Warm the durable overview + panel snapshots now instead of leaving the
 * site showing zeros until the next scheduled snapshot sweep. Fire-and-forget and
 * fully failure-isolated: `warmSiteSnapshot` never throws, and this wrapper swallows
 * anything that slips through — a warm error must never fail the enrollment that just
 * succeeded. Dynamic import breaks the panel-data → iwsl-managed import cycle (same
 * reason bindIdentityViaHealthCheck imports iwsl-managed-ops dynamically).
 */
function warmSnapshotAfterEnroll(site: string): void {
  void (async () => {
    try {
      const { warmSiteSnapshot } = await import("./manage/site-sweep");
      const result = await warmSiteSnapshot(site);
      if (!result.ok) {
        console.warn(`[wordpress:iwsl] post-enroll snapshot warm for ${site} did not capture: ${result.reason ?? "unknown"}`);
      }
    } catch (err) {
      console.warn(`[wordpress:iwsl] post-enroll snapshot warm for ${site} failed:`, err instanceof Error ? err.message : err);
    }
  })();
}

export async function enrollManagedSite(site: string, actor: string, channel?: ReleaseChannel): Promise<ExternalSiteView> {
  const summary = (await listSites()).find((s) => s.site === site);
  if (!summary) throw new AddonHttpError("Site not found", 404);
  const pod = await requireRunningPod(site);

  const existing = await getManagedLink(site);
  if (existing) {
    if (existing.state === "active" && existing.fingerprintConfirmed) {
      throw new AddonHttpError("This site is already linked — unlink it first to re-enroll", 409);
    }
    // A half-finished previous attempt: start over from a clean record.
    await deleteExternalSite(existing.siteId);
  }

  const record = await createManagedSiteRecord({ siteName: site, url: `https://${summary.host}` }, actor, undefined, channel);
  try {
    const pkg = await buildConnectorPackage();
    await execInWpPod(pod, installConnectorScript(), {
      stdin: pkg.zip.toString("base64"),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    await execInWpPod(pod, resetConnectorStateScript());

    const bundle = await issueBundle(record.siteId);
    await execInWpPod(pod, enrollBundleScript(), { stdin: bundle.content });

    const { stdout } = await execInWpPod(pod, readEnrollProofScript());
    const outcome = await verifyExternalSite(record.siteId, extractProofJson(stdout));
    if (!outcome.ok) {
      throw new AddonHttpError(`Enrollment verification failed: ${outcome.reason}`, 502);
    }
    const view = await confirmFingerprint(record.siteId);
    await bindIdentityViaHealthCheck(site);
    warmSnapshotAfterEnroll(site);
    return view;
  } catch (err) {
    // Roll the record back so a retry starts clean instead of hitting the
    // duplicate guard; the enroll secret is burned with it.
    await deleteExternalSite(record.siteId).catch(() => {});
    throw err;
  }
}

/**
 * Remove the link record and best-effort clean the plugin out of the pod.
 * The record deletion is the security-relevant part (no signing target left);
 * a pod that's down just keeps an inert deactivated plugin until deletion.
 */
export async function unlinkManagedSite(site: string): Promise<void> {
  const existing = await getManagedLink(site);
  if (!existing) throw new AddonHttpError("This site has no connector link", 404);
  await deleteExternalSite(existing.siteId);
  const pod = await findWpPodName(site);
  if (pod) {
    await execInWpPod(pod, uninstallConnectorScript()).catch((err) => {
      console.warn(`[wordpress:iwsl] connector cleanup for ${site} failed:`, err instanceof Error ? err.message : err);
    });
  }
}
