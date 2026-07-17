import { NextResponse } from "next/server";
import { isPrometheusConfigured, promQueryInstant, promScalar } from "@/lib/prometheus";
import { withAuth } from "@/lib/with-auth";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/metrics/storage-vitals — live storage saturation pulled straight from
// Prometheus via instant PromQL. Powers the StorageVitalsWidget on the
// monitoring Signals board: the board tracked CPU/mem/pods/ingress and OOM/node
// pressure, but nothing surfaced PVC or node-disk fill — a homelab's disks fill
// silently until a write fails. Every metric is queried independently
// (Promise.allSettled) so one missing exporter degrades a single tile to null
// instead of failing the whole card.
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageVitals {
  /** Fullest single PVC as a percentage of its capacity. */
  maxPvcPct: number | null;
  /** Count of PVCs at or above the near-full threshold. */
  pvcsNearFull: number | null;
  /** Cluster-wide PVC bytes used as a percentage of total provisioned capacity. */
  clusterPvcPct: number | null;
  /** Fullest node real filesystem (ext4/xfs/btrfs) as a percentage of its size. */
  nodeDiskPct: number | null;
}

/** One entry in the "fullest PVCs" list — namespace/name plus used percentage. */
export interface FullestPvc {
  namespace: string;
  name: string;
  pct: number;
}

export interface StorageVitalsResponse {
  available: boolean;
  error?: string;
  vitals?: StorageVitals;
  fullestPvcs?: FullestPvc[];
  generatedAt?: string;
}

// A PVC is "near full" (amber) once used/capacity crosses this ratio.
const NEAR_FULL_RATIO = 0.8;

// Node filesystems worth alerting on: real block filesystems only. Excludes
// tmpfs/overlay/rootfs and other pseudo-mounts (e.g. Talos mounts its writable
// data partition at /var as xfs; the read-only rootfs is noise here). Matching
// on fstype rather than a hardcoded mountpoint keeps this portable across nodes.
const REAL_FS = 'fstype=~"ext4|xfs|btrfs"';

// PromQL kept declarative so each tile is independently swappable and one bad
// query never masks the others. Uses kubelet volume-stats (PVC used/capacity)
// and node-exporter filesystem metrics shipped by kube-prometheus-stack.
const QUERIES = {
  maxPvcPct: "100 * max(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes)",
  pvcsNearFull: `count(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes >= ${NEAR_FULL_RATIO}) or on() vector(0)`,
  clusterPvcPct:
    "100 * sum(kubelet_volume_stats_used_bytes) / clamp_min(sum(kubelet_volume_stats_capacity_bytes), 1)",
  nodeDiskPct: `100 * max(1 - (node_filesystem_avail_bytes{${REAL_FS}} / node_filesystem_size_bytes{${REAL_FS}}))`,
} as const satisfies Record<keyof StorageVitals, string>;

// Top offenders for the widget's list. topk keeps the payload bounded regardless
// of PVC count; the widget renders the first few.
const FULLEST_PVCS_QUERY =
  "topk(5, 100 * (kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes))";

function round(value: number | null, digits: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Fetch the fullest PVCs, sorted descending. Swallows its own error to an empty
 * list so a failure here never blanks the scalar tiles (which are the primary
 * signal); the list is supplementary.
 */
async function fetchFullestPvcs(): Promise<FullestPvc[]> {
  try {
    const series = await promQueryInstant(FULLEST_PVCS_QUERY);
    return series
      .map((s) => ({
        namespace: s.metric?.namespace ?? "",
        name: s.metric?.persistentvolumeclaim ?? "",
        pct: round(Number(s.value?.[1]), 1),
      }))
      .filter((p): p is FullestPvc => p.name !== "" && p.pct !== null)
      .sort((a, b) => b.pct - a.pct);
  } catch {
    return [];
  }
}

export const GET = withAuth({ permission: "cluster:read" }, async () => {
  if (!isPrometheusConfigured()) {
    return NextResponse.json<StorageVitalsResponse>(
      { available: false, error: "Metrics backend not configured. Set PROMETHEUS_URL environment variable." },
      { status: 503 },
    );
  }

  const keys = Object.keys(QUERIES) as Array<keyof StorageVitals>;
  const [scalarSettled, fullestPvcs] = await Promise.all([
    Promise.allSettled(keys.map((key) => promScalar(QUERIES[key]))),
    fetchFullestPvcs(),
  ]);

  const vitals = {} as StorageVitals;
  keys.forEach((key, index) => {
    const outcome = scalarSettled[index];
    const value = outcome.status === "fulfilled" ? outcome.value : null;
    // Percentages get 1 decimal; the near-full count stays whole.
    vitals[key] = round(value, key === "pvcsNearFull" ? 0 : 1);
  });

  const anyResolved = Object.values(vitals).some((value) => value !== null) || fullestPvcs.length > 0;
  if (!anyResolved) {
    return NextResponse.json<StorageVitalsResponse>(
      { available: false, error: "Prometheus reachable but returned no data for storage vitals." },
      { status: 503 },
    );
  }

  return NextResponse.json<StorageVitalsResponse>({
    available: true,
    vitals,
    fullestPvcs,
    generatedAt: new Date().toISOString(),
  });
});
