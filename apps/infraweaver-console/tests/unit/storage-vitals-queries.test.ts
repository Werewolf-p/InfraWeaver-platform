/**
 * Guards the Storage Vitals PromQL wiring against the "phantom metric" trap that
 * bit the ingress tiles (nginx metrics on a Traefik cluster → always "—"). These
 * metric names were validated against the live Prometheus before shipping:
 *   - kubelet_volume_stats_{used,capacity}_bytes  (PVC fill, kubelet)
 *   - node_filesystem_{avail,size}_bytes          (node disk, node-exporter)
 * The node-disk tile must filter on fstype (ext4|xfs|btrfs), NOT mountpoint="/":
 * Talos mounts its writable partition at /var, so a "/" filter returns no series.
 */
const promScalar = jest.fn<Promise<number | null>, [string]>();
const promQueryInstant = jest.fn<Promise<Array<{ metric?: Record<string, string>; value?: [number | string, string] }>>, [string]>();

// Stub next/server so importing the route handler doesn't pull in the web
// Request/Response globals (absent in the jsdom test env). The handler's
// response is not inspected here — only the PromQL passed to Prometheus is.
jest.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: unknown) => ({ body, init }) },
}));

jest.mock("@/lib/prometheus", () => ({
  isPrometheusConfigured: () => true,
  promScalar: (query: string) => promScalar(query),
  promQueryInstant: (query: string) => promQueryInstant(query),
}));

// Bypass auth/RBAC — the handler ignores its request args, so return it raw.
jest.mock("@/lib/with-auth", () => ({
  withAuth: (_opts: unknown, handler: (...args: unknown[]) => unknown) => handler,
}));

import { GET } from "@/app/api/metrics/storage-vitals/route";

type RawHandler = (req?: unknown, segment?: unknown) => Promise<unknown>;

describe("storage-vitals PromQL", () => {
  beforeEach(() => {
    promScalar.mockReset();
    promScalar.mockResolvedValue(1);
    promQueryInstant.mockReset();
    promQueryInstant.mockResolvedValue([]);
  });

  it("queries validated kubelet PVC and node-exporter disk metrics", async () => {
    await (GET as unknown as RawHandler)();
    const queries = promScalar.mock.calls.map((call) => call[0]);
    const all = queries.join("\n");

    // PVC fill comes from the kubelet volume-stats pair.
    expect(all).toContain("kubelet_volume_stats_used_bytes");
    expect(all).toContain("kubelet_volume_stats_capacity_bytes");
    // Node disk comes from node-exporter filesystem metrics.
    expect(all).toContain("node_filesystem_avail_bytes");
    expect(all).toContain("node_filesystem_size_bytes");
  });

  it("filters node disk by fstype, never by a hardcoded mountpoint=\"/\"", async () => {
    await (GET as unknown as RawHandler)();
    const nodeDiskQuery = promScalar.mock.calls.map((c) => c[0]).find((q) => q.includes("node_filesystem_avail_bytes"));

    expect(nodeDiskQuery).toBeDefined();
    expect(nodeDiskQuery).toMatch(/fstype=~"ext4\|xfs\|btrfs"/);
    expect(nodeDiskQuery).not.toContain('mountpoint="/"');
  });

  it("maps topk fullest-PVC series to namespace/name/pct, sorted descending", async () => {
    promQueryInstant.mockResolvedValue([
      { metric: { namespace: "jellyfin", persistentvolumeclaim: "media" }, value: [0, "12.3"] },
      { metric: { namespace: "game-hub", persistentvolumeclaim: "palworld" }, value: [0, "88.7"] },
      { metric: { namespace: "nomatch" }, value: [0, "50"] }, // no PVC name → dropped
    ]);

    const result = (await (GET as unknown as RawHandler)()) as { body: { fullestPvcs: Array<{ namespace: string; name: string; pct: number }> } };
    const list = result.body.fullestPvcs;

    expect(list).toEqual([
      { namespace: "game-hub", name: "palworld", pct: 88.7 },
      { namespace: "jellyfin", name: "media", pct: 12.3 },
    ]);
  });

  it("stays available when the fullest-PVC list query fails (scalars still render)", async () => {
    promQueryInstant.mockRejectedValue(new Error("boom"));

    const result = (await (GET as unknown as RawHandler)()) as { body: { available: boolean; fullestPvcs: unknown[] } };

    expect(result.body.available).toBe(true);
    expect(result.body.fullestPvcs).toEqual([]);
  });
});
