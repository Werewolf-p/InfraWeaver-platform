"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Users, UserMinus, Clock } from "lucide-react";
import { toast } from "sonner";
import type { PlayerEntry, PlayerStats, ServerDetail } from "./types";
import { countryFlag, fetchJson } from "./utils";

export function PlayersTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  void server;

  const { data: players } = useQuery({
    queryKey: ["game-hub", "players", name],
    queryFn: () => fetchJson<{ players: PlayerEntry[]; count: number }>(`/api/game-hub/servers/${name}/players`),
    refetchInterval: 30000,
  });

  const { data: stats } = useQuery({
    queryKey: ["game-hub", "player-stats", name],
    queryFn: () => fetchJson<PlayerStats>(`/api/game-hub/servers/${name}/stats`),
    refetchInterval: 60000,
  });

  async function doAction(action: "kick" | "ban", player: string) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/players`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, player }),
      });
      toast.success(`${action === "kick" ? "Disconnected" : "Blocked"} ${player}`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "players", name] });
    } catch (error) {
      toast.error(String(error));
    }
  }

  const onlinePlayers = players?.players ?? [];
  const recentJoins = stats?.recentJoins ?? [];
  const recentLeaves = stats?.recentLeaves ?? [];

  return (
    <div className="grid xl:grid-cols-[1.3fr_1fr] gap-4">
      <div className="space-y-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]">
              <Users className="w-4 h-4 text-[#38bdf8]" /> Online Players
            </div>
            <span className="text-sm font-mono text-[#f2f2f2]">{players?.count ?? 0}</span>
          </div>

          <div className="space-y-2">
            {onlinePlayers.length === 0 ? (
              <p className="text-sm text-[#666]">No players online</p>
            ) : onlinePlayers.map((player) => (
              <div key={player.name} className="rounded-lg border border-[#222] px-3 py-2 flex items-center gap-2 text-sm">
                <span className="text-base flex-shrink-0">{countryFlag(player.countryCode)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[#f2f2f2] truncate font-medium">{player.name}</p>
                  <p className="text-xs text-[#666]">
                    {player.ip ?? "—"} · <span className="text-[#999]">{player.group}</span>
                  </p>
                </div>
                <button
                  onClick={() => doAction("kick", player.name)}
                  className="text-xs text-yellow-300 hover:text-yellow-200 px-2 py-1 rounded hover:bg-yellow-500/10 transition-colors"
                >
                  Disconnect
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Block ${player.name}?`)) doAction("ban", player.name);
                  }}
                  className="text-xs text-red-300 hover:text-red-200 px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                >
                  Block
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888] mb-3">
            <Clock className="w-4 h-4 text-[#c084fc]" /> Recent Activity
          </div>
          <p className="text-xs text-[#666] mb-2">
            Unique today: <span className="text-[#f2f2f2]">{stats?.uniqueToday ?? 0}</span>
          </p>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-[#555] mb-2 uppercase tracking-wide text-[10px]">Recent Joins</p>
              <div className="space-y-1">
                {recentJoins.length === 0
                  ? <p className="text-[#555]">None</p>
                  : recentJoins.slice(0, 10).map((entry, index) => (
                    <div key={`${entry.player}-${index}`} className="flex items-center gap-1.5">
                      <UserMinus className="w-3 h-3 text-green-500 rotate-180" />
                      <span className="text-[#d4d4d4] truncate">{entry.player}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div>
              <p className="text-[#555] mb-2 uppercase tracking-wide text-[10px]">Recent Leaves</p>
              <div className="space-y-1">
                {recentLeaves.length === 0
                  ? <p className="text-[#555]">None</p>
                  : recentLeaves.slice(0, 10).map((entry, index) => (
                    <div key={`${entry.player}-${index}`} className="flex items-center gap-1.5">
                      <UserMinus className="w-3 h-3 text-[#555]" />
                      <span className="text-[#d4d4d4] truncate">{entry.player}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
