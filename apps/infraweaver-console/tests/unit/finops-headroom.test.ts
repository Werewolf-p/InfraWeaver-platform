import { describe, expect, it } from "@jest/globals";
import { computeHeadroom, fitReplicas, type NodeCapacity } from "@/lib/finops/headroom";

const nodes: NodeCapacity[] = [
  { name: "cp1", allocatableCpuM: 4000, allocatableMemMi: 8192, requestedCpuM: 1000, requestedMemMi: 2048 },
  { name: "cp2", allocatableCpuM: 4000, allocatableMemMi: 8192, requestedCpuM: 3800, requestedMemMi: 7000 },
];

describe("computeHeadroom", () => {
  it("computes per-node free capacity and cluster totals, most-free first", () => {
    const h = computeHeadroom(nodes);
    expect(h.nodes[0].name).toBe("cp1"); // more free mem
    expect(h.nodes[0].freeCpuM).toBe(3000);
    expect(h.cluster.freeCpuM).toBe(3200);
    expect(h.cluster.freeMemMi).toBe(6144 + 1192);
  });

  it("clamps negative free capacity at zero (over-committed node)", () => {
    const h = computeHeadroom([{ name: "x", allocatableCpuM: 1000, allocatableMemMi: 1000, requestedCpuM: 1500, requestedMemMi: 1200 }]);
    expect(h.nodes[0].freeCpuM).toBe(0);
    expect(h.nodes[0].freeMemMi).toBe(0);
  });
});

describe("fitReplicas", () => {
  it("bin-packs a footprint per node and sums (replica must fit on one node)", () => {
    const h = computeHeadroom(nodes);
    // cp1 free: 3000m/6144Mi → by 500m = 6, by 1024Mi = 6 → 6. cp2 free: 200m/1192Mi → 0.
    expect(fitReplicas(h.nodes, 500, 1024)).toBe(6);
  });

  it("returns 0 for an empty footprint", () => {
    expect(fitReplicas(computeHeadroom(nodes).nodes, 0, 0)).toBe(0);
  });
});
