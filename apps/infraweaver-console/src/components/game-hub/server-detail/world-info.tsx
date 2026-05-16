"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "@/lib/notify";
import {
  isMinecraftGameType,
  readPropertiesServerFile,
  safeErrorMessage,
} from "./file-helpers";

interface WorldInfoProps {
  serverName: string;
  mountPath: string;
  gameType: string;
}

const LABELS: Array<[key: string, label: string]> = [
  ["level-name", "World Name"],
  ["difficulty", "Difficulty"],
  ["gamemode", "Gamemode"],
  ["max-players", "Max Players"],
  ["motd", "MOTD"],
];

export function WorldInfo({ serverName, mountPath, gameType }: WorldInfoProps) {
  const propertiesPath = `${mountPath}/server.properties`;
  const enabled = isMinecraftGameType(gameType);

  const worldQuery = useQuery({
    queryKey: ["game-hub", "world-info", serverName, propertiesPath],
    queryFn: () => readPropertiesServerFile(serverName, propertiesPath),
    enabled,
  });

  useEffect(() => {
    if (worldQuery.error) toast.error(safeErrorMessage(worldQuery.error));
  }, [worldQuery.error]);

  if (!enabled) return null;

  const seed = worldQuery.data?.["level-seed"] ?? "";

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[#f2f2f2]">World Info</h3>
        <p className="text-xs text-[#888]">Minecraft world settings from server.properties.</p>
      </div>

      {worldQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading world info…
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {LABELS.map(([key, label]) => (
              <div key={key} className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3">
                <div className="text-[11px] uppercase tracking-wide text-[#555]">{label}</div>
                <div className="mt-2 break-words text-sm text-[#f2f2f2]">
                  {worldQuery.data?.[key] || "—"}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[#555]">Seed</div>
                <div className="mt-2 break-all font-mono text-sm text-[#f2f2f2]">
                  {seed || "—"}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!seed) {
                      toast.error("No world seed available");
                      return;
                    }
                    navigator.clipboard.writeText(seed)
                      .then(() => toast.success("Seed copied"))
                      .catch((error: unknown) => toast.error(safeErrorMessage(error)));
                  }}
                  className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] px-3 py-2 text-sm text-[#f2f2f2]"
                >
                  <Copy className="h-4 w-4" /> Copy
                </button>
                {seed ? (
                  <a
                    href={`https://www.chunkbase.com/apps/seed-map#${encodeURIComponent(seed)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] px-3 py-2 text-sm text-[#f2f2f2]"
                  >
                    <ExternalLink className="h-4 w-4" /> Chunkbase
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
