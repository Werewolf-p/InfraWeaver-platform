/**
 * Blast-radius & dependency traversal — PURE (cycle-safe, unit-testable).
 *
 * Over a DependencyGraph where `from → to` means "from depends on to":
 *  - blast radius  = who BREAKS if this node dies   (reverse reachability)
 *  - dependencies  = what this node NEEDS to be healthy (forward reachability)
 *
 * These answer the incident-time question the old flat app grid could not:
 * "if OpenBao/Postgres/Authentik goes down, what breaks?"
 */

import type { DependencyGraph } from "./graph-model";

/** A dependency with high fan-in is a single point of failure at/above this many dependents. */
export const SPOF_MIN_DEPENDENTS = 3;

export interface Reach {
  direct: string[];
  transitive: string[];
}

interface Adjacency {
  forward: Map<string, Set<string>>;
  reverse: Map<string, Set<string>>;
}

function buildAdjacency(graph: DependencyGraph): Adjacency {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    forward.set(node.id, new Set());
    reverse.set(node.id, new Set());
  }
  for (const edge of graph.edges) {
    if (!forward.has(edge.from)) forward.set(edge.from, new Set());
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    forward.get(edge.from)!.add(edge.to);
    reverse.get(edge.to)!.add(edge.from);
  }
  return { forward, reverse };
}

/** BFS reachability from `start` over `adj`, excluding `start`, splitting direct vs transitive. */
function reach(adj: Map<string, Set<string>>, start: string): Reach {
  const directSet = new Set(adj.get(start) ?? []);
  const visited = new Set<string>([start]);
  const queue = [...directSet];
  const all = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    all.add(current);
    for (const next of adj.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  const direct = [...directSet];
  const transitive = [...all].filter((id) => !directSet.has(id));
  return { direct: direct.sort(), transitive: transitive.sort() };
}

/** Nodes that break if `nodeId` dies (reverse reachability). */
export function computeBlastRadius(graph: DependencyGraph, nodeId: string): Reach {
  return reach(buildAdjacency(graph).reverse, nodeId);
}

/** What `nodeId` needs to be healthy (forward reachability). */
export function computeDependencies(graph: DependencyGraph, nodeId: string): Reach {
  return reach(buildAdjacency(graph).forward, nodeId);
}

export interface SpofFinding {
  nodeId: string;
  dependentCount: number;
}

/** Nodes whose total blast radius meets the fan-in threshold, ranked descending. */
export function findSinglePointsOfFailure(graph: DependencyGraph, minDependents: number = SPOF_MIN_DEPENDENTS): SpofFinding[] {
  const { reverse } = buildAdjacency(graph);
  return graph.nodes
    .map((node) => {
      const r = reach(reverse, node.id);
      return { nodeId: node.id, dependentCount: r.direct.length + r.transitive.length };
    })
    .filter((finding) => finding.dependentCount >= minDependents)
    .sort((a, b) => b.dependentCount - a.dependentCount);
}

export type OrphanReason = "no-consumers" | "isolated";

export interface OrphanFinding {
  nodeId: string;
  reason: OrphanReason;
}

/**
 * Dead weight: services nothing depends on (no incoming edge = no consumers),
 * and app/service nodes with no edges at all (isolated). External/fqdn/entity
 * nodes are entrypoints/leaves and are never orphans.
 */
export function findOrphans(graph: DependencyGraph): OrphanFinding[] {
  const { forward, reverse } = buildAdjacency(graph);
  const findings: OrphanFinding[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "service" && node.kind !== "app") continue;
    const inbound = reverse.get(node.id)?.size ?? 0;
    const outbound = forward.get(node.id)?.size ?? 0;
    if (inbound === 0 && outbound === 0) findings.push({ nodeId: node.id, reason: "isolated" });
    else if (inbound === 0 && node.kind === "service") findings.push({ nodeId: node.id, reason: "no-consumers" });
  }
  return findings;
}
