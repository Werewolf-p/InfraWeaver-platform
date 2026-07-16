/**
 * Path finding over the dependency graph — PURE (cycle-safe, depth-capped).
 *
 * Answers triage questions the flat grid could not: "how does the public
 * ingress actually reach Postgres?" / "what chain connects app A to Authentik?"
 * Edges are `from → to` = "from depends on to".
 */

import type { DependencyGraph } from "./graph-model";

/** Cap on path enumeration depth, so a dense graph can't explode combinatorially. */
export const MAX_PATH_DEPTH = 8;

function adjacency(graph: DependencyGraph): Map<string, string[]> {
  const forward = new Map<string, string[]>();
  for (const node of graph.nodes) forward.set(node.id, []);
  for (const edge of graph.edges) {
    if (!forward.has(edge.from)) forward.set(edge.from, []);
    forward.get(edge.from)!.push(edge.to);
  }
  return forward;
}

/** Shortest dependency path from → to (BFS), or null when unreachable. Includes both endpoints. */
export function findShortestPath(graph: DependencyGraph, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId];
  const forward = adjacency(graph);
  if (!forward.has(fromId)) return null;

  const prev = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of forward.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      prev.set(next, current);
      if (next === toId) {
        const path = [toId];
        let step = toId;
        while (prev.has(step)) {
          step = prev.get(step)!;
          path.unshift(step);
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** All simple (acyclic) paths from → to up to `maxDepth` edges. Cycle-safe via the on-stack visited set. */
export function findAllPaths(graph: DependencyGraph, fromId: string, toId: string, maxDepth: number = MAX_PATH_DEPTH): string[][] {
  const forward = adjacency(graph);
  if (!forward.has(fromId)) return [];
  const results: string[][] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();

  const walk = (node: string) => {
    stack.push(node);
    onStack.add(node);
    if (node === toId && stack.length > 1) {
      results.push([...stack]);
    } else if (stack.length <= maxDepth) {
      for (const next of forward.get(node) ?? []) {
        if (!onStack.has(next)) walk(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  };

  walk(fromId);
  return results.sort((a, b) => a.length - b.length);
}

/** Set of "from|to" edge keys along a path, for highlight rendering. */
export function pathEdgeKeys(path: string[]): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < path.length - 1; i += 1) keys.add(`${path[i]}|${path[i + 1]}`);
  return keys;
}
