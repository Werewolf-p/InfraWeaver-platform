"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, MessageSquare, Shield, Users } from "lucide-react";
import { toast } from "sonner";
import type { BansData, ChatMessage, PlayerEntry, PlayerStats, ServerDetail, WhitelistData } from "./types";
import { countryFlag, fetchJson } from "./utils";

export function PlayersTab({ name, server }: { name: string; server: ServerDetail }) {
  const queryClient = useQueryClient();
  const { data: players } = useQuery({ queryKey: ["game-hub", "players", name], queryFn: () => fetchJson<{ players: PlayerEntry[]; count: number }>(`/api/game-hub/servers/${name}/players`), refetchInterval: 30000 });
  const { data: stats } = useQuery({ queryKey: ["game-hub", "player-stats", name], queryFn: () => fetchJson<PlayerStats>(`/api/game-hub/servers/${name}/stats`), refetchInterval: 60000 });
  const { data: chat } = useQuery({ queryKey: ["game-hub", "chat", name], queryFn: () => fetchJson<{ messages: ChatMessage[] }>(`/api/game-hub/servers/${name}/chat`), refetchInterval: 30000 });
  const { data: whitelist } = useQuery({ queryKey: ["game-hub", "whitelist", name], queryFn: () => fetchJson<WhitelistData>(`/api/game-hub/servers/${name}/whitelist`) });
  const { data: bans } = useQuery({ queryKey: ["game-hub", "bans", name], queryFn: () => fetchJson<BansData>(`/api/game-hub/servers/${name}/bans`) });

  async function doAction(action: "kick" | "ban", player: string) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/players`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, player }) });
      toast.success(`${action}ed ${player}`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "players", name] });
      queryClient.invalidateQueries({ queryKey: ["game-hub", "bans", name] });
    } catch (error) { toast.error(String(error)); }
  }

  async function whitelistPlayer(player: string) {
    try {
      await fetchJson(`/api/game-hub/servers/${name}/whitelist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", player }) });
      toast.success(`${player} whitelisted`);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "whitelist", name] });
    } catch (error) { toast.error(String(error)); }
  }

  return (
    <div className="grid xl:grid-cols-[1.3fr_1fr] gap-4">
      <div className="space-y-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888]"><Users className="w-4 h-4 text-[#38bdf8]" /> Online Players</div><span className="text-sm text-[#f2f2f2]">{players?.count ?? 0}</span></div>
          <div className="space-y-2">{(players?.players ?? []).length === 0 ? <p className="text-sm text-[#666]">No players online</p> : players?.players.map((player) => <div key={player.name} className="rounded-lg border border-[#222] px-3 py-2 flex items-center gap-2 text-sm"><span>{countryFlag(player.countryCode)}</span><div className="flex-1 min-w-0"><p className="text-[#f2f2f2] truncate">{player.name}</p><p className="text-xs text-[#666]">{player.ip ?? "No IP"} · <span className={player.group === "OP" ? "text-yellow-300" : player.group === "Admin" ? "text-blue-300" : "text-[#999]"}>{player.group}</span></p></div><button onClick={() => whitelistPlayer(player.name)} className="text-xs text-[#0078D4]">Whitelist</button><button onClick={() => doAction("kick", player.name)} className="text-xs text-yellow-300">Kick</button><button onClick={() => doAction("ban", player.name)} className="text-xs text-red-300">Ban</button></div>)}</div>
        </div>

        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4">
          <div className="flex items-center gap-2 mb-3 text-xs uppercase tracking-wide text-[#888]"><MessageSquare className="w-4 h-4 text-[#c084fc]" /> Chat Viewer</div>
          <div className="space-y-2 max-h-72 overflow-y-auto">{(chat?.messages ?? []).length === 0 ? <p className="text-sm text-[#666]">No chat messages</p> : chat?.messages.map((message, index) => <div key={`${message.player}-${index}`} className="rounded-lg border border-[#222] px-3 py-2 text-sm"><p className="text-[#f2f2f2]"><span className="text-[#60a5fa]">{message.player}</span> {message.message}</p><p className="text-[11px] text-[#666] mt-1">{new Date(message.timestamp).toLocaleString()}</p></div>)}</div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><div className="text-xs uppercase tracking-wide text-[#888] mb-3">Recent Logins</div><div className="space-y-1 text-sm">{(stats?.recentJoins ?? []).slice(0, 10).map((entry, index) => <div key={`${entry.player}-${index}`} className="text-[#d4d4d4]">{entry.player}</div>)}</div></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888] mb-3"><Shield className="w-4 h-4 text-[#22c55e]" /> Whitelist</div><p className="text-xs text-[#777] mb-2">{whitelist?.enabled ? "Enabled" : "Disabled"}</p><div className="space-y-1 text-sm">{(whitelist?.players ?? []).slice(0, 12).map((player) => <div key={player} className="text-[#d4d4d4]">{player}</div>)}</div></div>
        <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4"><div className="flex items-center gap-2 text-xs uppercase tracking-wide text-[#888] mb-3"><Ban className="w-4 h-4 text-red-400" /> Banned Players</div><div className="space-y-1 text-sm">{(bans?.bans ?? []).slice(0, 12).map((entry, index) => <div key={`${entry.name}-${index}`} className="text-[#d4d4d4]">{entry.name}</div>)}</div></div>
      </div>
    </div>
  );
}
