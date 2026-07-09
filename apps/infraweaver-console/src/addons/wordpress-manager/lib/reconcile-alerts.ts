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
 * we published an Event per poll the bell would fill with duplicates, so within a
 * single outage window we keep ONE alert per site: the first failure publishes,
 * subsequent failures are deduped by `alertedSites`, and the guard is only cleared
 * when the site recovers (`clearSsoUnavailableAlert`, called on a successful
 * reconcile). The next outage then re-arms and alerts again.
 *
 * Kubernetes garbage-collects Events (kube-apiserver `--event-ttl`, default ~1h),
 * so a plain "publish once, dedup forever" guard has a latent gap: after the first
 * Event is GC'd, an outage lasting longer than the TTL silently vanishes from the
 * bell even though the gate is still stuck. To close that, we RE-PUBLISH a fresh
 * Event once `REPUBLISH_INTERVAL_MS` has elapsed since the last publish. The
 * interval is well under the Event TTL, so there is always a live Event on the
 * bell for as long as the outage lasts; `alertedSites` still collapses the per-poll
 * storm inside each interval. Each refresh is a fresh Event (`generateName`),
 * matching how a post-recovery re-arm already works.
 */

const REASON = "SsoGateUnavailable";

// Re-publish the stuck-gate Event once this much time has elapsed since the last
// publish for a site. Kept comfortably under the Kubernetes Event TTL (~1h) so the
// alert is refreshed — and stays on the notification bell — before the prior Event
// is garbage-collected. Large enough that a long outage only re-publishes a couple
// of times per hour, not once per dashboard poll.
const REPUBLISH_INTERVAL_MS = 30 * 60 * 1000;

// Sites with a live (unrecovered) SSO-gate alert. Module-level so it is shared
// across every poll-driven `reconcileSite` on this replica.
const alertedSites = new Set<string>();

// site -> epoch ms of its last published stuck-gate Event. Written in lockstep with
// `alertedSites` (both set on publish, both cleared on recovery/failure), so an
// entry here means "an Event was published at time T" and drives the re-publish
// decision above.
const lastPublishedAt = new Map<string, number>();

/**
 * Emit a deduped platform alert that `site`'s SSO gate is stuck because Authentik
 * is unavailable. No-op if this site already alerted within the current refresh
 * window; once `REPUBLISH_INTERVAL_MS` has elapsed it re-publishes a fresh Event so
 * a multi-hour outage stays on the bell after the prior Event is GC'd.
 * Best-effort: a failed publish drops the guard so the next poll retries, and never
 * rejects (the reconcile loop must not wedge on telemetry). `now` is injectable for
 * deterministic tests; production callers use the wall clock.
 */
export function emitSsoUnavailableAlert(site: string, detail: string, now: number = Date.now()): void {
  const lastPublished = lastPublishedAt.get(site);
  const withinRefreshWindow = lastPublished !== undefined && now - lastPublished < REPUBLISH_INTERVAL_MS;
  if (alertedSites.has(site) && withinRefreshWindow) return;

  alertedSites.add(site);
  lastPublishedAt.set(site, now);
  void publishGateStuckEvent(site, detail).catch(() => {
    // Publish failed (RBAC, API down). Re-arm so a later poll can land the alert
    // instead of silently swallowing this outage.
    alertedSites.delete(site);
    lastPublishedAt.delete(site);
  });
}

/**
 * Clear the alert guard for `site` — called when the site reconciles successfully,
 * so a FUTURE outage produces a fresh alert rather than being deduped away.
 */
export function clearSsoUnavailableAlert(site: string): void {
  alertedSites.delete(site);
  lastPublishedAt.delete(site);
}

/** Test-only: drop all guard state so each test starts from a clean window. */
export function __resetSsoAlertsForTest(): void {
  alertedSites.clear();
  lastPublishedAt.clear();
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
