"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { Network, Wifi, WifiOff } from "lucide-react";
import { timeAgo, cn } from "@/lib/utils";

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

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Network</h2>
        <p className="text-sm text-slate-400">Netbird VPN mesh peers</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {peers?.map((peer: { id: string; name: string; ip: string; connected: boolean; lastSeen?: string; groups?: string[] }) => (
            <motion.div
              key={peer.id}
              whileHover={{ scale: 1.01 }}
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
