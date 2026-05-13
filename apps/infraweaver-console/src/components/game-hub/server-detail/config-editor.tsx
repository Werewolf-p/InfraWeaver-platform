"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  isMinecraftGameType,
  parseProperties,
  safeErrorMessage,
  serializeProperties,
  type PropertyLine,
  readServerFile,
  writeServerFile,
} from "./file-helpers";

const MINECRAFT_SETTING_DESCRIPTIONS: Record<string, string> = {
  "max-players": "Maximum number of players",
  difficulty: "Difficulty (peaceful/easy/normal/hard)",
  gamemode: "Default gamemode",
  "level-name": "World folder name",
  "level-seed": "World generation seed",
  motd: "Message of the day",
  pvp: "Allow PvP",
  "online-mode": "Verify player accounts",
  "server-port": "Game server port",
  "max-world-size": "Max world radius in blocks",
};

interface ConfigEditorProps {
  serverName: string;
  filePath: string;
  title: string;
  gameType: string;
}

export function ConfigEditor({
  serverName,
  filePath,
  title,
  gameType,
}: ConfigEditorProps) {
  const queryClient = useQueryClient();
  const isPropertiesFile = filePath.toLowerCase().endsWith(".properties");
  const [rawContent, setRawContent] = useState("");
  const [propertyLines, setPropertyLines] = useState<PropertyLine[]>([]);
  const [saving, setSaving] = useState(false);

  const fileQuery = useQuery({
    queryKey: ["game-hub", "file-content", serverName, filePath],
    queryFn: () => readServerFile(serverName, filePath),
  });

  useEffect(() => {
    if (fileQuery.data === undefined) return;
    setRawContent(fileQuery.data);
    setPropertyLines(isPropertiesFile ? parseProperties(fileQuery.data) : []);
  }, [fileQuery.data, isPropertiesFile]);

  useEffect(() => {
    if (fileQuery.error) toast.error(safeErrorMessage(fileQuery.error));
  }, [fileQuery.error]);

  const propertyEntries = useMemo(
    () =>
      propertyLines.flatMap((line, index) =>
        line.type === "pair" ? [{ ...line, index }] : [],
      ),
    [propertyLines],
  );

  function updateProperty(index: number, value: string) {
    setPropertyLines((current) =>
      current.map((line, currentIndex) =>
        currentIndex === index && line.type === "pair" ? { ...line, value } : line,
      ),
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      await writeServerFile(
        serverName,
        filePath,
        isPropertiesFile ? serializeProperties(propertyLines) : rawContent,
      );
      toast.success(`${title} saved`);
      queryClient.invalidateQueries({
        queryKey: ["game-hub", "file-content", serverName, filePath],
      });
    } catch (error) {
      toast.error(safeErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-[#f2f2f2]">{title}</h3>
          <p className="text-xs text-[#888]">{filePath}</p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || fileQuery.isLoading}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0078D4] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Save
        </button>
      </div>

      {fileQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading config…
        </div>
      ) : isPropertiesFile ? (
        <div className="space-y-3">
          {propertyEntries.length === 0 ? (
            <p className="text-sm text-[#888]">No editable properties found.</p>
          ) : (
            propertyEntries.map((entry) => {
              const description = isMinecraftGameType(gameType)
                ? MINECRAFT_SETTING_DESCRIPTIONS[entry.key]
                : undefined;
              return (
                <label key={`${entry.key}-${entry.index}`} className="block space-y-1">
                  <span className="flex items-center gap-2 text-xs font-medium text-[#f2f2f2]">
                    <span>{entry.key}</span>
                    {description ? (
                      <span title={description} className="text-[#888]">
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </span>
                  {description ? (
                    <span className="block text-[11px] text-[#555]">{description}</span>
                  ) : null}
                  <input
                    value={entry.value}
                    onChange={(event) => updateProperty(entry.index, event.target.value)}
                    className="w-full rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
                  />
                </label>
              );
            })
          )}
        </div>
      ) : (
        <textarea
          value={rawContent}
          onChange={(event) => setRawContent(event.target.value)}
          rows={16}
          className="min-h-[320px] w-full rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3 font-mono text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
        />
      )}
    </div>
  );
}
