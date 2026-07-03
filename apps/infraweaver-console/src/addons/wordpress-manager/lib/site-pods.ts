/**
 * The runtime pods behind one WordPress site (the WordPress deployment and its
 * MariaDB), discovered by the site label the manifests stamp on every pod. This
 * powers the site detail's pod list + firewall panel, so a wordpress-scoped
 * user can see their site's runtime without cluster-wide pod permissions.
 *
 * Pure shaping only — the k8s listing lives in provision.ts (`listSitePods`) so
 * this module stays unit-testable without the kubernetes client.
 */

export type SiteComponent = "wordpress" | "db" | "other";

export interface SitePod {
  name: string;
  component: SiteComponent;
  /** Waiting reason (e.g. ImagePullBackOff) when present, else the pod phase. */
  status: string;
  ready: boolean;
  restarts: number;
  startedAt?: string;
}

/** Minimal slice of V1Pod the shaper reads — keeps it unit-testable with plain objects. */
export interface SitePodSource {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    creationTimestamp?: Date | string;
  };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      ready?: boolean;
      restartCount?: number;
      state?: { waiting?: { reason?: string } };
    }>;
  };
}

function componentOf(labels: Record<string, string> | undefined): SiteComponent {
  const value = labels?.["infraweaver.io/component"];
  return value === "wordpress" || value === "db" ? value : "other";
}

/** Shape raw pod objects into the site pod summaries the UI renders. */
export function shapeSitePods(items: readonly SitePodSource[]): SitePod[] {
  return items
    .map((item) => {
      const statuses = item.status?.containerStatuses ?? [];
      const waiting = statuses.find((s) => s.state?.waiting?.reason)?.state?.waiting?.reason;
      const created = item.metadata?.creationTimestamp;
      return {
        name: item.metadata?.name ?? "",
        component: componentOf(item.metadata?.labels),
        status: waiting || item.status?.phase || "Unknown",
        ready: statuses.length > 0 && statuses.every((s) => s.ready === true),
        restarts: statuses.reduce((sum, s) => sum + (s.restartCount ?? 0), 0),
        startedAt: created instanceof Date ? created.toISOString() : created || undefined,
      };
    })
    .filter((pod) => pod.name !== "")
    // WordPress first, then the database, then anything else — stable for the UI.
    .sort((a, b) => {
      const rank: Record<SiteComponent, number> = { wordpress: 0, db: 1, other: 2 };
      return rank[a.component] - rank[b.component] || a.name.localeCompare(b.name);
    });
}
