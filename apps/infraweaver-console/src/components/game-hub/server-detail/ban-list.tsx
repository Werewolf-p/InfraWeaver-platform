"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Loader2, Trash2 } from "lucide-react";
import { toast } from "@/lib/notify";
import {
  readJsonServerFile,
  safeErrorMessage,
  writeServerFile,
} from "./file-helpers";

interface BannedPlayerEntry {
  uuid: string;
  name: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

interface BannedIpEntry {
  ip: string;
  created: string;
  source: string;
  expires: string;
  reason: string;
}

interface BanListProps {
  serverName: string;
  mountPath: string;
}

function formatBanDate(value: string) {
  if (!value || value.toLowerCase() === "forever") return value || "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

export function BanList({ serverName, mountPath }: BanListProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"players" | "ips">("players");
  const [saving, setSaving] = useState(false);
  const playersPath = `${mountPath}/banned-players.json`;
  const ipsPath = `${mountPath}/banned-ips.json`;

  const bansQuery = useQuery({
    queryKey: ["game-hub", "bans", serverName],
    queryFn: async () => {
      const [players, ips] = await Promise.all([
        readJsonServerFile<BannedPlayerEntry[]>(serverName, playersPath, []),
        readJsonServerFile<BannedIpEntry[]>(serverName, ipsPath, []),
      ]);
      return {
        players: Array.isArray(players) ? players : [],
        ips: Array.isArray(ips) ? ips : [],
      };
    },
  });

  useEffect(() => {
    if (bansQuery.error) toast.error(safeErrorMessage(bansQuery.error));
  }, [bansQuery.error]);

  async function saveFile(path: string, value: unknown, successMessage: string) {
    setSaving(true);
    try {
      await writeServerFile(serverName, path, JSON.stringify(value, null, 2));
      toast.success(successMessage);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "bans", serverName] });
    } catch (error) {
      toast.error(safeErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const players = bansQuery.data?.players ?? [];
  const ips = bansQuery.data?.ips ?? [];
  const activeEntries = activeTab === "players" ? players : ips;

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[#f2f2f2]">Ban List</h3>
          <p className="text-xs text-[#888]">Review banned players and IP addresses.</p>
        </div>
        <div className="inline-flex rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-1">
          {([
            ["players", "Players"],
            ["ips", "IPs"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setActiveTab(value)}
              className={`rounded-md px-3 py-1.5 text-xs transition ${
                activeTab === value
                  ? "bg-[#0078D4] text-white"
                  : "text-[#888] hover:text-[#f2f2f2]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {bansQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading bans…
        </div>
      ) : activeEntries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#2a2a2a] p-4 text-sm text-[#888]">
          No bans.
        </div>
      ) : (
        <div className="space-y-2">
          {activeTab === "players"
            ? players.map((entry) => (
                <div
                  key={entry.uuid || entry.name}
                  className="flex flex-col gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm text-[#f2f2f2]">
                      <Ban className="h-4 w-4 text-red-300" />
                      <span className="truncate">{entry.name}</span>
                    </div>
                    <div className="text-xs text-[#888]">Reason: {entry.reason || "No reason provided"}</div>
                    <div className="text-xs text-[#555]">
                      Created {formatBanDate(entry.created)} • Expires {formatBanDate(entry.expires)} • Source {entry.source || "Unknown"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void saveFile(
                        playersPath,
                        players.filter((current) => current.uuid !== entry.uuid),
                        `Unbanned ${entry.name}`,
                      )
                    }
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] px-3 py-2 text-sm text-[#f2f2f2] transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" /> Unban
                  </button>
                </div>
              ))
            : ips.map((entry) => (
                <div
                  key={entry.ip}
                  className="flex flex-col gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm text-[#f2f2f2]">
                      <Ban className="h-4 w-4 text-red-300" />
                      <span className="truncate">{entry.ip}</span>
                    </div>
                    <div className="text-xs text-[#888]">Reason: {entry.reason || "No reason provided"}</div>
                    <div className="text-xs text-[#555]">
                      Created {formatBanDate(entry.created)} • Expires {formatBanDate(entry.expires)} • Source {entry.source || "Unknown"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void saveFile(
                        ipsPath,
                        ips.filter((current) => current.ip !== entry.ip),
                        `Unbanned ${entry.ip}`,
                      )
                    }
                    disabled={saving}
                    className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] px-3 py-2 text-sm text-[#f2f2f2] transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" /> Unban
                  </button>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
