"use client";
import { useMemo, useState } from "react";
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

const STATUS_LEGEND: Array<{ status: string; label: string }> = [
  { status: "healthy", label: "healthy" },
  { status: "degraded", label: "degraded" },
  { status: "down", label: "down" },
];

function TopologyMap({ data }: { data: TopologyData }) {
  const [selected, setSelected] = useState<string | null>(null);

  const layers: Record<number, TopoNode[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const n of data.nodes) {
    const layer = TYPE_LAYERS[n.type] ?? 3;
    if (layer <= 3) layers[layer].push(n);
  }

  const NODE_W = 92;
  const NODE_H = 40;
  const H_GAP = 16;
  const V_GAP = 44;

  const maxPerLayer = Math.max(...Object.values(layers).map(l => l.length), 1);
  const svgW = Math.max(maxPerLayer * (NODE_W + H_GAP), 360);
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

  // Blast-radius: the selected node plus every edge that touches it and the
  // nodes on the other end. Null when nothing is selected (everything active).
  const highlight = useMemo(() => {
    if (!selected) return null;
    const nodes = new Set<string>([selected]);
    const edges = new Set<number>();
    data.edges.forEach((e, i) => {
      if (e.source === selected || e.target === selected) {
        edges.add(i);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    });
    return { nodes, edges };
  }, [selected, data.edges]);

  function toggle(id: string) {
    setSelected((current) => (current === id ? null : id));
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-white/10 bg-slate-50 dark:bg-[#0f0f0f]/60 p-3" style={{ WebkitOverflowScrolling: "touch" }}>
      {selected ? (
        <button type="button" onClick={() => setSelected(null)} className="mb-2 text-xs text-indigo-600 hover:underline dark:text-indigo-300">
          Clear selection · showing connections for {data.nodes.find((n) => n.id === selected)?.name ?? selected}
        </button>
      ) : (
        <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">Select a node to trace its connections. Hover for full details.</p>
      )}
      <svg
        width={svgW}
        height={svgH}
        className="min-w-[420px] sm:min-w-full"
        role="group"
        aria-label="Service dependency topology"
      >
        {data.edges.map((e, i) => {
          const src = positions[e.source];
          const tgt = positions[e.target];
          if (!src || !tgt) return null;
          const x1 = src.x + NODE_W / 2;
          const y1 = src.y + NODE_H;
          const x2 = tgt.x + NODE_W / 2;
          const y2 = tgt.y;
          const cy = (y1 + y2) / 2;
          const isActive = highlight ? highlight.edges.has(i) : true;
          return (
            <path
              key={i}
              d={`M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`}
              stroke={isActive ? "rgba(99,102,241,0.75)" : "rgba(100,116,139,0.18)"}
              strokeWidth={isActive && highlight ? 2 : 1.5}
              fill="none"
            />
          );
        })}
        {data.nodes.map(n => {
          const pos = positions[n.id];
          if (!pos) return null;
          const color = TYPE_COLORS[n.type] ?? "#64748b";
          const ring = STATUS_RING[n.status] ?? "#64748b";
          const isSelected = selected === n.id;
          const isDimmed = Boolean(highlight) && !highlight?.nodes.has(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${pos.x},${pos.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${n.name}, ${n.type} in ${n.namespace}, status ${n.status}`}
              onClick={() => toggle(n.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggle(n.id);
                }
              }}
              className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[2.5]"
              style={{ opacity: isDimmed ? 0.3 : 1 }}
            >
              <title>{`${n.name}\n${n.type} · ${n.namespace}\nstatus: ${n.status}`}</title>
              <rect width={NODE_W} height={NODE_H} rx={6} fill={`${color}22`} stroke={ring} strokeWidth={isSelected ? 2.5 : 1.5} />
              <circle cx={10} cy={NODE_H / 2} r={4} fill={ring} />
              <text x={18} y={NODE_H / 2 + 1} fontSize={10} fill="currentColor" dominantBaseline="middle" className="font-mono text-slate-700 dark:text-slate-100">
                {n.name.length > 12 ? n.name.slice(0, 12) + "…" : n.name}
              </text>
              <text x={18} y={NODE_H / 2 + 12} fontSize={9} fill="currentColor" dominantBaseline="middle" className="text-slate-500 dark:text-slate-400">
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
            <div className="mt-3 space-y-2">
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 sm:mr-1">Type</span>
                {Object.entries(TYPE_COLORS).map(([type, color]) => (
                  <div key={type} className="flex min-h-[32px] items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 sm:text-xs">
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color + "44", border: `1px solid ${color}` }} />
                    {type}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 sm:mr-1">Status ring</span>
                {STATUS_LEGEND.map(({ status, label }) => (
                  <div key={status} className="flex min-h-[32px] items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 sm:text-xs">
                    <span className="w-3 h-3 rounded-full flex-shrink-0 border-2" style={{ borderColor: STATUS_RING[status], backgroundColor: "transparent" }} />
                    {label}
                  </div>
                ))}
              </div>
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
