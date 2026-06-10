"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Network, Wifi, WifiOff, ExternalLink } from "lucide-react";
import { timeAgo, cn } from "@/lib/utils";
import { internalHost } from "@/lib/domain";
import { type ArgoApp } from "@/hooks/use-argocd";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { PageHeader } from "@/components/ui/page-header";

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

function getNetbirdDeploymentStatus(app: ArgoApp | undefined): { label: string; colorClass: string; pulse: boolean } {
  if (!app) return { label: "Unknown", colorClass: "bg-slate-500/10 text-slate-500 dark:text-slate-400", pulse: false };
  const { health, sync } = app.status;
  if (health.status === "Healthy" && sync.status === "Synced")
    return { label: "Online", colorClass: "bg-green-500/10 text-green-400", pulse: false };
  if (health.status === "Progressing" && sync.status === "Synced")
    return { label: "Syncing", colorClass: "bg-yellow-500/10 text-yellow-400", pulse: true };
  if (health.status === "Degraded")
    return { label: "Degraded", colorClass: "bg-red-500/10 text-red-400", pulse: false };
  if (sync.status === "OutOfSync")
    return { label: "Out of Sync", colorClass: "bg-orange-500/10 text-orange-400", pulse: false };
  return { label: health.status, colorClass: "bg-slate-500/10 text-slate-500 dark:text-slate-400", pulse: false };
}

export default function NetworkPage() {
  const { data: peers, isLoading } = useQuery({
    queryKey: ["netbird", "peers"],
    queryFn: async () => {
      const res = await fetch("/api/netbird/peers");
      if (!res.ok) throw new Error("Failed to fetch peers");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: topoData } = useQuery<TopologyData>({
    queryKey: ["network", "topology"],
    queryFn: async () => {
      const res = await fetch("/api/network/topology");
      return res.json();
    },
    staleTime: 60000,
    refetchInterval: 120000,
  });

  const { data: apps } = useQuery<ArgoApp[]>({
    queryKey: ["argocd", "apps"],
    queryFn: async () => {
      const res = await fetch("/api/argocd/apps");
      if (!res.ok) throw new Error("Failed to fetch apps");
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 15000,
  });

  const netbirdApp = (apps ?? []).find(
    a => a.metadata.name === "platform-netbird" || a.metadata.name === "apps-netbird"
  );
  const deploymentStatus = getNetbirdDeploymentStatus(netbirdApp);

  const connectedCount = (peers ?? []).filter((p: { connected: boolean }) => p.connected).length;
  const totalCount = (peers ?? []).length;

  return (
    <div>
      <PageHeader icon={Network} title="Network" subtitle="Services, ingress, and network topology" />
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-network pointer-events-none" />
        <div className="relative flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-emerald-400" />
            Network
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Netbird VPN mesh peers</p>
        </div>
        <a
          href={`https://${internalHost("netbird")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-2 text-sm text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-100 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white active:scale-95 touch-manipulation sm:w-auto"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open NetBird Dashboard
        </a>
        </div>
      </div>

      {/* NetBird Deployment Status from ArgoCD */}
      <div className="mb-4 flex flex-col gap-4 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <Network className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">NetBird Deployment</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">ArgoCD managed deployment status</p>
          </div>
        </div>
        <div className={cn("inline-flex min-h-[44px] items-center gap-1.5 self-start rounded-full border px-3 py-2 text-sm font-medium sm:self-auto sm:text-xs", deploymentStatus.colorClass)}>
          {deploymentStatus.pulse && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
          )}
          {deploymentStatus.label}
        </div>
      </div>

      {!isLoading && totalCount > 0 && (
        <div className="mb-5 flex flex-col gap-4 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-500/20 flex items-center justify-center">
              <Network className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-white">NetBird Peers</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{connectedCount} of {totalCount} connected</p>
            </div>
          </div>
          <div className={cn(
            "inline-flex min-h-[44px] items-center rounded-full px-3 py-2 text-sm font-medium sm:text-xs",
            connectedCount === totalCount ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"
          )}>
            {connectedCount === totalCount ? "All Online" : `${totalCount - connectedCount} Offline`}
          </div>
        </div>
      )}

      {topoData && topoData.nodes.length > 0 && (
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
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {peers?.map((peer: { id: string; name: string; ip: string; connected: boolean; lastSeen?: string; groups?: string[] }) => (
            <motion.div
              key={peer.id}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
              className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 touch-manipulation sm:p-5"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {peer.connected ? (
                    <Wifi className="w-4 h-4 text-green-400" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-slate-500" />
                  )}
                  <span className="text-base font-medium text-gray-900 dark:text-white sm:text-sm">{peer.name}</span>
                </div>
                <span className={cn("inline-flex min-h-[32px] items-center rounded-full px-2.5 py-1 text-sm font-medium sm:text-xs", peer.connected ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-500")}>
                  {peer.connected ? "Connected" : "Offline"}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 text-sm text-slate-500 dark:text-slate-400 sm:grid-cols-2 sm:text-xs">
                <div className="flex justify-between">
                  <span>IP</span>
                  <span className="font-mono text-slate-700 dark:text-slate-300">{peer.ip}</span>
                </div>
                <div className="flex justify-between">
                  <span>Last seen</span>
                  <span>{peer.lastSeen ? timeAgo(peer.lastSeen) : "Unknown"}</span>
                </div>
                {peer.groups && peer.groups.length > 0 && (
                  <div className="flex justify-between">
                    <span>Groups</span>
                    <div className="flex flex-wrap justify-end gap-1">{peer.groups.map((group) => <span key={group} className="rounded-full border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-2 py-0.5 text-[11px] text-slate-700 dark:text-slate-300">{group}</span>)}</div>
                  </div>
                )}
              </div>
            </motion.div>
          )) ?? (
            <div className="col-span-2 text-center py-16 text-slate-500">
              <Network className="w-10 h-10 mb-3 mx-auto opacity-30" />
              <p>No peers found or Netbird API unavailable</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
