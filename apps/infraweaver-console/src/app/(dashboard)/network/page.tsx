"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Network, Wifi, WifiOff, ExternalLink } from "lucide-react";
import { timeAgo, cn } from "@/lib/utils";
import { type ArgoApp } from "@/hooks/use-argocd";

function getNetbirdDeploymentStatus(app: ArgoApp | undefined): { label: string; colorClass: string; pulse: boolean } {
  if (!app) return { label: "Unknown", colorClass: "bg-slate-500/10 text-slate-400", pulse: false };
  const { health, sync } = app.status;
  if (health.status === "Healthy" && sync.status === "Synced")
    return { label: "Online", colorClass: "bg-green-500/10 text-green-400", pulse: false };
  if (health.status === "Progressing" && sync.status === "Synced")
    return { label: "Syncing", colorClass: "bg-yellow-500/10 text-yellow-400", pulse: true };
  if (health.status === "Degraded")
    return { label: "Degraded", colorClass: "bg-red-500/10 text-red-400", pulse: false };
  if (sync.status === "OutOfSync")
    return { label: "Out of Sync", colorClass: "bg-orange-500/10 text-orange-400", pulse: false };
  return { label: health.status, colorClass: "bg-slate-500/10 text-slate-400", pulse: false };
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
      <div className="relative rounded-xl overflow-hidden mb-6">
        <div className="absolute inset-0 page-gradient-network pointer-events-none" />
        <div className="relative flex items-center justify-between p-5">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Network className="w-5 h-5 text-emerald-400" />
            Network
          </h2>
          <p className="text-sm text-slate-400">Netbird VPN mesh peers</p>
        </div>
        <a
          href="https://netbird.int.rlservers.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-slate-300 hover:text-white hover:bg-white/10 transition-colors active:scale-95"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open NetBird Dashboard
        </a>
        </div>
      </div>

      {/* NetBird Deployment Status from ArgoCD */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <Network className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">NetBird Deployment</p>
            <p className="text-xs text-slate-400">ArgoCD managed deployment status</p>
          </div>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs px-3 py-1 rounded-full font-medium border", deploymentStatus.colorClass)}>
          {deploymentStatus.pulse && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse flex-shrink-0" />
          )}
          {deploymentStatus.label}
        </div>
      </div>

      {!isLoading && totalCount > 0 && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-500/20 flex items-center justify-center">
              <Network className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <p className="text-sm font-semibold text-white">NetBird Peers</p>
              <p className="text-xs text-slate-400">{connectedCount} of {totalCount} connected</p>
            </div>
          </div>
          <div className={cn(
            "text-xs px-3 py-1 rounded-full font-medium",
            connectedCount === totalCount ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"
          )}>
            {connectedCount === totalCount ? "All Online" : `${totalCount - connectedCount} Offline`}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {peers?.map((peer: { id: string; name: string; ip: string; connected: boolean; lastSeen?: string; groups?: string[] }) => (
            <motion.div
              key={peer.id}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
              className="bg-white/5 border border-white/10 rounded-xl p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {peer.connected ? (
                    <Wifi className="w-4 h-4 text-green-400" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-slate-500" />
                  )}
                  <span className="text-sm font-medium text-white">{peer.name}</span>
                </div>
                <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", peer.connected ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-500")}>
                  {peer.connected ? "Connected" : "Offline"}
                </span>
              </div>
              <div className="space-y-1 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>IP</span>
                  <span className="font-mono text-slate-300">{peer.ip}</span>
                </div>
                <div className="flex justify-between">
                  <span>Last seen</span>
                  <span>{peer.lastSeen ? timeAgo(peer.lastSeen) : "Unknown"}</span>
                </div>
                {peer.groups && peer.groups.length > 0 && (
                  <div className="flex justify-between">
                    <span>Groups</span>
                    <span>{peer.groups.join(", ")}</span>
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
