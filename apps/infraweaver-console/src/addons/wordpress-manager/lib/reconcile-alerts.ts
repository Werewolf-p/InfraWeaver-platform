import { makeCoreApi } from "@/lib/kube-client";
import { WORDPRESS_NAMESPACE } from "./wordpress-rbac";
import { resourceNames } from "./naming";

/**
 * Surface a stuck WordPress SSO gate as a platform notification.
 *
 * The notification bell (`/api/notifications`) is fed by Kubernetes `Warning`
 * Events (`loadClusterEvents` → `listEventForAllNamespaces`), so emitting a
 * Warning Event on the site's Deployment is what makes a stuck gate visible
 * WITHOUT log-grepping.
 *
 * A stuck gate re-fails on EVERY dashboard poll (each poll re-runs the idempotent
 * reconcile, which re-throws `SsoUnavailableError` until Authentik recovers). If
 * we published an Event per poll the bell would fill with duplicates, so we keep
 * ONE alert per site per outage window: the first failure publishes, subsequent
 * failures are deduped by `alertedSites`, and the guard is only cleared when the
 * site recovers (`clearSsoUnavailableAlert`, called on a successful reconcile).
 * The next outage then re-arms and alerts again.
 */

const REASON = "SsoGateUnavailable";

// Sites with a live (unrecovered) SSO-gate alert. Module-level so it is shared
// across every poll-driven `reconcileSite` on this replica.
const alertedSites = new Set<string>();

/**
 * Emit a deduped platform alert that `site`'s SSO gate is stuck because Authentik
 * is unavailable. No-op if this site already alerted in the current outage window.
 * Best-effort: a failed publish drops the guard so the next poll retries, and never
 * rejects (the reconcile loop must not wedge on telemetry).
 */
export function emitSsoUnavailableAlert(site: string, detail: string): void {
  if (alertedSites.has(site)) return;
  alertedSites.add(site);
  void publishGateStuckEvent(site, detail).catch(() => {
    // Publish failed (RBAC, API down). Re-arm so a later poll can land the alert
    // instead of silently swallowing this outage.
    alertedSites.delete(site);
  });
}

/**
 * Clear the alert guard for `site` — called when the site reconciles successfully,
 * so a FUTURE outage produces a fresh alert rather than being deduped away.
 */
export function clearSsoUnavailableAlert(site: string): void {
  alertedSites.delete(site);
}

/** Test-only: drop all guard state so each test starts from a clean window. */
export function __resetSsoAlertsForTest(): void {
  alertedSites.clear();
}

async function publishGateStuckEvent(site: string, detail: string): Promise<void> {
  const core = makeCoreApi();
  const names = resourceNames(site);
  const now = new Date();
  await core.createNamespacedEvent({
    namespace: WORDPRESS_NAMESPACE,
    body: {
      apiVersion: "v1",
      kind: "Event",
      metadata: {
        // `generateName` (not a fixed name) so a re-armed alert after recovery is a
        // fresh Event; dedup within a window is handled by `alertedSites`, above.
        generateName: `wp-sso-gate-${site}-`,
        namespace: WORDPRESS_NAMESPACE,
        labels: {
          "app.kubernetes.io/managed-by": "infraweaver-console",
          "infraweaver.io/component": "wordpress-reconcile",
          "infraweaver.io/site": site,
        },
      },
      involvedObject: {
        kind: "Deployment",
        namespace: WORDPRESS_NAMESPACE,
        name: names.wp,
      },
      reason: REASON,
      message: `SSO gate for ${site} is stuck — Authentik unavailable (${detail}). Auto-retrying each poll; login stays blocked until it recovers.`,
      type: "Warning",
      source: { component: "infraweaver-console/wordpress-reconcile" },
      reportingComponent: "infraweaver-console/wordpress-reconcile",
      reportingInstance: site,
      action: "Reconcile",
      // Core/v1 legacy timestamps — the notification bell (`loadClusterEvents`)
      // sorts by `lastTimestamp`, so a single stuck-gate Event stays current.
      firstTimestamp: now,
      lastTimestamp: now,
      count: 1,
    },
  });
}
