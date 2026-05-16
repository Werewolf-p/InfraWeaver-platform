"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Network, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { EmptyState, PageScaffold } from "@/components/ui";
import { useRBAC } from "@/hooks/use-rbac";
import { cn, timeAgo } from "@/lib/utils";

interface NetBirdPeer {
  id: string;
  name: string;
  ip: string | null;
  connected: boolean;
  lastSeen: string | null;
  groups?: string[];
  os?: string | null;
}

export default function VpnPage() {
  const { canAny } = useRBAC();
  const canViewVpn = canAny(["infra:read", "cluster:admin"]);
  const [search, setSearch] = useState("");

  const { data: peers = [], isLoading, isFetching, refetch } = useQuery<NetBirdPeer[]>({
    queryKey: ["netbird", "vpn-page"],
    queryFn: async () => {
      const response = await fetch("/api/netbird/peers", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to load NetBird peers");
      return response.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: canViewVpn,
  });

  const filteredPeers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return peers.filter((peer) => !query
      || peer.name.toLowerCase().includes(query)
      || (peer.ip ?? "").toLowerCase().includes(query)
      || (peer.os ?? "").toLowerCase().includes(query));
  }, [peers, search]);

  const connectedCount = peers.filter((peer) => peer.connected).length;
  const offlineCount = peers.length - connectedCount;
  const staleCount = peers.filter((peer) => peer.lastSeen && Date.now() - new Date(peer.lastSeen).getTime() > 24 * 3_600_000).length;

  if (!canViewVpn) {
    return (
      <PageScaffold icon={Network} title="VPN" description="NetBird peer inventory proxied through the console API.">
        <EmptyState
          icon={ShieldAlert}
          title="Infrastructure access required"
          description="You need infra:read or cluster:admin permission to inspect NetBird peers."
        />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      icon={Network}
      title="VPN"
      description="NetBird management peers, connectivity state, and recent activity from the internal management API."
      actions={
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
        >
          <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          Refresh
        </button>
      }
      loading={isLoading}
      isEmpty={!isLoading && filteredPeers.length === 0}
      emptyState={{
        icon: Network,
        title: peers.length === 0 ? "No NetBird peers found" : "No VPN peers matched",
        description: peers.length === 0
          ? "The NetBird management API did not return any peers in the current environment."
          : "Try a different search term to find the peer you need.",
      }}
    >
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Peers</p>
            <p className="mt-2 text-3xl font-semibold text-white">{peers.length}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">Connected</p>
            <p className="mt-2 text-3xl font-semibold text-emerald-200">{connectedCount}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-amber-100/80">Attention</p>
            <p className="mt-2 text-3xl font-semibold text-amber-200">{offlineCount + staleCount}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search peer name, IP, or operating system…"
              className="w-full rounded-xl border border-white/10 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-500/50"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/70">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-slate-950/80 text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Peer</th>
                  <th className="px-4 py-3">IP</th>
                  <th className="px-4 py-3">Last seen</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredPeers.map((peer) => (
                  <tr key={peer.id} className="border-t border-white/5">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <span className={cn("h-2.5 w-2.5 rounded-full", peer.connected ? "bg-emerald-400" : "bg-slate-500")} />
                        <div>
                          <p className="font-medium text-white">{peer.name}</p>
                          <p className="mt-1 text-xs text-slate-500">{peer.os ?? "Unknown OS"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4 font-mono text-slate-300">{peer.ip ?? "—"}</td>
                    <td className="px-4 py-4 text-slate-400">{peer.lastSeen ? timeAgo(peer.lastSeen) : "Never"}</td>
                    <td className="px-4 py-4">
                      <span className={cn(
                        "rounded-full border px-2.5 py-1 text-xs font-medium",
                        peer.connected
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                      )}>
                        {peer.connected ? "Connected" : "Offline"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </PageScaffold>
  );
}
