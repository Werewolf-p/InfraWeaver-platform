"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Radar, Unplug } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";
import { computeBlastRadius, computeDependencies, type OrphanFinding, type SpofFinding } from "@/lib/topology/blast-radius";
import type { DependencyGraph, GraphNode } from "@/lib/topology/graph-model";

interface GraphResponse extends DependencyGraph {
  available: boolean;
  reason?: string;
  spof?: SpofFinding[];
  orphans?: OrphanFinding[];
}

function labelFor(nodes: GraphNode[], id: string): string {
  const node = nodes.find((n) => n.id === id);
  if (!node) return id;
  return node.namespace ? `${node.namespace}/${node.name}` : node.name;
}

function IdList({ ids, nodes, empty }: { ids: string[]; nodes: GraphNode[]; empty: string }) {
  if (ids.length === 0) return <p className="text-xs text-slate-500">{empty}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <li key={id} className="rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-white/5 dark:text-slate-300">
          {labelFor(nodes, id)}
        </li>
      ))}
    </ul>
  );
}

export function DependencyGraphPanel() {
  const { data, isLoading } = useApiQuery<GraphResponse>({
    queryKey: ["network", "dependency-graph"],
    path: "/api/network/dependency-graph",
    staleTime: 120_000,
  });

  const [selected, setSelected] = useState<string>("");

  const graph = useMemo<DependencyGraph>(() => ({ nodes: data?.nodes ?? [], edges: data?.edges ?? [] }), [data]);
  const blast = useMemo(() => (selected ? computeBlastRadius(graph, selected) : null), [graph, selected]);
  const deps = useMemo(() => (selected ? computeDependencies(graph, selected) : null), [graph, selected]);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />;

  if (!data?.available) {
    return (
      <div className="rounded-xl border border-gray-200 bg-slate-100 p-4 text-sm text-slate-500 dark:border-white/10 dark:bg-slate-900/60 dark:text-slate-400">
        Dependency graph unavailable — the Cilium dataplane is not reporting network policies yet.
      </div>
    );
  }

  const spof = data.spof ?? [];
  const orphans = data.orphans ?? [];
  const blastTotal = blast ? blast.direct.length + blast.transitive.length : 0;
  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 bg-slate-100 p-4 backdrop-blur-sm dark:border-white/10 dark:bg-slate-900/60">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
          <Radar className="h-4 w-4 text-indigo-400" /> Blast radius
        </span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="min-w-56 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-900 dark:border-white/10 dark:bg-slate-800 dark:text-white"
        >
          <option value="">Select a service or app…</option>
          {sortedNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {labelFor(graph.nodes, n.id)} · {n.kind}
            </option>
          ))}
        </select>
        <span className="text-xs text-slate-500">{graph.nodes.length} nodes · {graph.edges.length} edges</span>
      </div>

      {selected && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-red-400">
              <ArrowUpRight className="h-3.5 w-3.5" /> Breaks if this dies ({blastTotal})
            </p>
            <IdList ids={[...(blast?.direct ?? []), ...(blast?.transitive ?? [])]} nodes={graph.nodes} empty="Nothing depends on this node." />
          </div>
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-sky-400">
              <ArrowDownRight className="h-3.5 w-3.5" /> This needs ({deps ? deps.direct.length + deps.transitive.length : 0})
            </p>
            <IdList ids={[...(deps?.direct ?? []), ...(deps?.transitive ?? [])]} nodes={graph.nodes} empty="This node has no declared dependencies." />
          </div>
        </div>
      )}

      {(spof.length > 0 || orphans.length > 0) && (
        <div className="grid grid-cols-1 gap-4 border-t border-gray-200 pt-3 dark:border-white/10 md:grid-cols-2">
          {spof.length > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> Single points of failure
              </p>
              <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                {spof.slice(0, 6).map((s) => (
                  <li key={s.nodeId} className="font-mono">{labelFor(graph.nodes, s.nodeId)} · {s.dependentCount} dependents</li>
                ))}
              </ul>
            </div>
          )}
          {orphans.length > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                <Unplug className="h-3.5 w-3.5" /> Orphans ({orphans.length})
              </p>
              <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                {orphans.slice(0, 6).map((o) => (
                  <li key={o.nodeId} className="font-mono">{labelFor(graph.nodes, o.nodeId)} · {o.reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
