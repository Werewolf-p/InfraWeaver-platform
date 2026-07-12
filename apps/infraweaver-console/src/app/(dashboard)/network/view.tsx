"use client";
import { Network } from "lucide-react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";

interface TopoNode {
  id: string;
  type: string;
  name: string;
  namespace: string;
  status: string;
}

interface TopoEdge {
  source: string;
  target: string;
}

interface TopologyData {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

const TYPE_LAYERS: Record<string, number> = {
  "ingress-controller": 0,
  "ingressroute": 1,
  "service": 2,
  "pod": 3,
};

const TYPE_COLORS: Record<string, string> = {
  "ingress-controller": "#3b82f6",
  "ingressroute": "#6366f1",
  "service": "#8b5cf6",
  "pod": "#10b981",
};

const STATUS_RING: Record<string, string> = {
  "healthy": "#22c55e",
  "degraded": "#f59e0b",
  "down": "#ef4444",
};

function TopologyMap({ data }: { data: TopologyData }) {
  const layers: Record<number, TopoNode[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const n of data.nodes) {
    const layer = TYPE_LAYERS[n.type] ?? 3;
    if (layer <= 3) layers[layer].push(n);
  }

  const NODE_W = 92;
  const NODE_H = 40;
  const H_GAP = 16;
  const V_GAP = 44;
  const LAYER_LABEL_W = 0;

  const maxPerLayer = Math.max(...Object.values(layers).map(l => l.length), 1);
  const svgW = Math.max(maxPerLayer * (NODE_W + H_GAP) + LAYER_LABEL_W, 360);
  const svgH = 4 * (NODE_H + V_GAP) + V_GAP;

  const positions: Record<string, { x: number; y: number }> = {};
  for (let li = 0; li <= 3; li++) {
    const layerNodes = layers[li] ?? [];
    const totalW = layerNodes.length * NODE_W + (layerNodes.length - 1) * H_GAP;
    const startX = (svgW - totalW) / 2;
    const y = li * (NODE_H + V_GAP) + V_GAP / 2;
    layerNodes.forEach((n, idx) => {
      positions[n.id] = { x: startX + idx * (NODE_W + H_GAP), y };
    });
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10 bg-[#0f0f0f]/60 p-3" style={{ WebkitOverflowScrolling: "touch" }}>
      <svg width={svgW} height={svgH} className="min-w-[420px] sm:min-w-full">
        {data.edges.map((e, i) => {
          const src = positions[e.source];
          const tgt = positions[e.target];
          if (!src || !tgt) return null;
          const x1 = src.x + NODE_W / 2;
          const y1 = src.y + NODE_H;
          const x2 = tgt.x + NODE_W / 2;
          const y2 = tgt.y;
          const cy = (y1 + y2) / 2;
          return (
            <path
              key={i}
              d={`M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`}
              stroke="rgba(99,102,241,0.3)"
              strokeWidth={1.5}
              fill="none"
            />
          );
        })}
        {data.nodes.map(n => {
          const pos = positions[n.id];
          if (!pos) return null;
          const color = TYPE_COLORS[n.type] ?? "#64748b";
          const ring = STATUS_RING[n.status] ?? "#64748b";
          return (
            <g key={n.id} transform={`translate(${pos.x},${pos.y})`}>
              <rect width={NODE_W} height={NODE_H} rx={6} fill={`${color}22`} stroke={ring} strokeWidth={1.5} />
              <circle cx={10} cy={NODE_H / 2} r={4} fill={ring} />
              <text x={18} y={NODE_H / 2 + 1} fontSize={10} fill="#e2e8f0" dominantBaseline="middle" className="font-mono">
                {n.name.length > 12 ? n.name.slice(0, 12) + "…" : n.name}
              </text>
              <text x={18} y={NODE_H / 2 + 12} fontSize={9} fill="#64748b" dominantBaseline="middle">
                {n.namespace}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function NetworkTopologyView() {
  const { data: topoData, isLoading } = useApiQuery<TopologyData>({
    queryKey: ["network", "topology"],
    path: "/api/network/topology",
    staleTime: 60000,
    refetchInterval: 120000,
  });

  return (
    <div>
      <PageHeader icon={Network} title="Network" subtitle="Services, ingress, and network topology" />

      {topoData && topoData.nodes.length > 0 ? (
        <div className="mb-5">
          <CollapsibleSection title="Service Topology" storageKey="network-topology" badge={<Network className="w-4 h-4 text-indigo-400 flex-shrink-0" />}>
            <TopologyMap data={topoData} />
            <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
              {Object.entries(TYPE_COLORS).map(([type, color]) => (
                <div key={type} className="flex min-h-[32px] items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 sm:text-xs">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color + "44", border: `1px solid ${color}` }} />
                  {type}
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="text-center py-16 text-slate-500">
          <Network className="w-10 h-10 mb-3 mx-auto opacity-30" />
          <p>No topology data available</p>
        </div>
      )}
    </div>
  );
}
