/**
 * Cluster headroom — PURE (unit-testable). Free capacity per node (allocatable
 * minus summed pod requests) and a "how many more replicas of footprint X fit"
 * estimate — the core homelab expansion decision Node Metrics never answered.
 */

export interface NodeCapacity {
  name: string;
  allocatableCpuM: number;
  allocatableMemMi: number;
  requestedCpuM: number;
  requestedMemMi: number;
}

export interface NodeHeadroom extends NodeCapacity {
  freeCpuM: number;
  freeMemMi: number;
}

export interface ClusterHeadroom {
  nodes: NodeHeadroom[];
  cluster: { allocatableCpuM: number; allocatableMemMi: number; freeCpuM: number; freeMemMi: number };
}

export function computeHeadroom(nodes: NodeCapacity[]): ClusterHeadroom {
  const withFree = nodes
    .map((node): NodeHeadroom => ({
      ...node,
      freeCpuM: Math.max(0, node.allocatableCpuM - node.requestedCpuM),
      freeMemMi: Math.max(0, node.allocatableMemMi - node.requestedMemMi),
    }))
    .sort((a, b) => b.freeMemMi - a.freeMemMi);

  const cluster = withFree.reduce(
    (acc, node) => {
      acc.allocatableCpuM += node.allocatableCpuM;
      acc.allocatableMemMi += node.allocatableMemMi;
      acc.freeCpuM += node.freeCpuM;
      acc.freeMemMi += node.freeMemMi;
      return acc;
    },
    { allocatableCpuM: 0, allocatableMemMi: 0, freeCpuM: 0, freeMemMi: 0 },
  );

  return { nodes: withFree, cluster };
}

/**
 * How many replicas of a {cpuM, memMi} footprint fit — bin-packed per node
 * (a replica must fit entirely on one node), summed. A zero/negative request
 * dimension is ignored for that dimension.
 */
export function fitReplicas(nodes: NodeHeadroom[], reqCpuM: number, reqMemMi: number): number {
  if (reqCpuM <= 0 && reqMemMi <= 0) return 0;
  return nodes.reduce((total, node) => {
    const byCpu = reqCpuM > 0 ? Math.floor(node.freeCpuM / reqCpuM) : Infinity;
    const byMem = reqMemMi > 0 ? Math.floor(node.freeMemMi / reqMemMi) : Infinity;
    const fit = Math.min(byCpu, byMem);
    return total + (Number.isFinite(fit) ? fit : 0);
  }, 0);
}
