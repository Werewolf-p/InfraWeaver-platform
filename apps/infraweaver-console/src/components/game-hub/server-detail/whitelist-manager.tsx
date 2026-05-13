"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  readJsonServerFile,
  readPropertiesServerFile,
  safeErrorMessage,
  writeServerFile,
} from "./file-helpers";

interface WhitelistEntry {
  uuid: string;
  name: string;
}

interface WhitelistManagerProps {
  serverName: string;
  mountPath: string;
}

const AVATAR_COLORS = [
  "bg-sky-500/20 text-sky-300 border-sky-500/30",
  "bg-purple-500/20 text-purple-300 border-purple-500/30",
  "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "bg-rose-500/20 text-rose-300 border-rose-500/30",
];

function createUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `whitelist-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function WhitelistManager({ serverName, mountPath }: WhitelistManagerProps) {
  const queryClient = useQueryClient();
  const [playerName, setPlayerName] = useState("");
  const [saving, setSaving] = useState(false);
  const whitelistPath = `${mountPath}/whitelist.json`;
  const propertiesPath = `${mountPath}/server.properties`;

  const whitelistQuery = useQuery({
    queryKey: ["game-hub", "whitelist", serverName],
    queryFn: async () => {
      const entries = await readJsonServerFile<WhitelistEntry[]>(
        serverName,
        whitelistPath,
        [],
      );
      return Array.isArray(entries) ? entries : [];
    },
  });

  const propertiesQuery = useQuery({
    queryKey: ["game-hub", "server-properties", serverName, propertiesPath],
    queryFn: () => readPropertiesServerFile(serverName, propertiesPath),
  });

  useEffect(() => {
    if (whitelistQuery.error) toast.error(safeErrorMessage(whitelistQuery.error));
  }, [whitelistQuery.error]);

  useEffect(() => {
    if (propertiesQuery.error) toast.error(safeErrorMessage(propertiesQuery.error));
  }, [propertiesQuery.error]);

  async function saveWhitelist(entries: WhitelistEntry[], successMessage: string) {
    setSaving(true);
    try {
      await writeServerFile(serverName, whitelistPath, JSON.stringify(entries, null, 2));
      toast.success(successMessage);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "whitelist", serverName] });
    } catch (error) {
      toast.error(safeErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function addPlayer() {
    const nextName = playerName.trim();
    if (!nextName) {
      toast.error("Enter a player name first");
      return;
    }
    const current = whitelistQuery.data ?? [];
    if (current.some((entry) => entry.name.toLowerCase() === nextName.toLowerCase())) {
      toast.error("That player is already whitelisted");
      return;
    }
    void saveWhitelist(
      [...current, { uuid: createUuid(), name: nextName }],
      `Added ${nextName} to the whitelist`,
    );
    setPlayerName("");
  }

  function removePlayer(entry: WhitelistEntry) {
    void saveWhitelist(
      (whitelistQuery.data ?? []).filter((current) => current.uuid !== entry.uuid),
      `Removed ${entry.name} from the whitelist`,
    );
  }

  const whitelistEnabled =
    (propertiesQuery.data?.whitelist ?? "false").toLowerCase() === "true";
  const entries = whitelistQuery.data ?? [];

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-[#f2f2f2]">Whitelist</h3>
          <p className="text-xs text-[#888]">Manage Minecraft whitelist entries.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={playerName}
            onChange={(event) => setPlayerName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addPlayer();
              }
            }}
            placeholder="Player name"
            className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
          />
          <button
            type="button"
            onClick={addPlayer}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-[#f2f2f2] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </button>
        </div>
      </div>

      {!whitelistEnabled ? (
        <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          Whitelist is disabled in server.properties. Players here will not be enforced until it is enabled.
        </div>
      ) : null}

      {whitelistQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading whitelist…
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#2a2a2a] p-4 text-sm text-[#888]">
          No players are currently whitelisted.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, index) => (
            <div
              key={entry.uuid || entry.name}
              className="flex items-center justify-between gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold ${AVATAR_COLORS[index % AVATAR_COLORS.length]}`}
                >
                  {entry.name.charAt(0).toUpperCase() || "?"}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm text-[#f2f2f2]">{entry.name}</div>
                  <div className="truncate font-mono text-[11px] text-[#555]">{entry.uuid}</div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removePlayer(entry)}
                disabled={saving}
                className="rounded-lg p-2 text-[#888] transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
