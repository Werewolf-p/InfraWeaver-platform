"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Shield, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  readJsonServerFile,
  safeErrorMessage,
  writeServerFile,
} from "./file-helpers";

interface OpEntry {
  uuid: string;
  name: string;
  level: number;
  bypassesPlayerLimit: boolean;
}

interface OpsManagerProps {
  serverName: string;
  mountPath: string;
}

const LEVEL_STYLES: Record<number, string> = {
  1: "border-slate-500/30 bg-slate-500/10 text-slate-200",
  2: "border-blue-500/30 bg-blue-500/10 text-blue-200",
  3: "border-purple-500/30 bg-purple-500/10 text-purple-200",
  4: "border-yellow-500/30 bg-yellow-500/10 text-yellow-200",
};

function createUuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function OpsManager({ serverName, mountPath }: OpsManagerProps) {
  const queryClient = useQueryClient();
  const [opName, setOpName] = useState("");
  const [saving, setSaving] = useState(false);
  const opsPath = `${mountPath}/ops.json`;

  const opsQuery = useQuery({
    queryKey: ["game-hub", "ops", serverName],
    queryFn: async () => {
      const entries = await readJsonServerFile<OpEntry[]>(serverName, opsPath, []);
      return Array.isArray(entries) ? entries : [];
    },
  });

  useEffect(() => {
    if (opsQuery.error) toast.error(safeErrorMessage(opsQuery.error));
  }, [opsQuery.error]);

  async function saveOps(entries: OpEntry[], successMessage: string) {
    setSaving(true);
    try {
      await writeServerFile(serverName, opsPath, JSON.stringify(entries, null, 2));
      toast.success(successMessage);
      queryClient.invalidateQueries({ queryKey: ["game-hub", "ops", serverName] });
    } catch (error) {
      toast.error(safeErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function addOp() {
    const nextName = opName.trim();
    if (!nextName) {
      toast.error("Enter an operator name first");
      return;
    }
    const current = opsQuery.data ?? [];
    if (current.some((entry) => entry.name.toLowerCase() === nextName.toLowerCase())) {
      toast.error("That operator already exists");
      return;
    }
    void saveOps(
      [
        ...current,
        {
          uuid: createUuid(),
          name: nextName,
          level: 4,
          bypassesPlayerLimit: false,
        },
      ],
      `Added ${nextName} as an operator`,
    );
    setOpName("");
  }

  function updateLevel(target: OpEntry, level: number) {
    void saveOps(
      (opsQuery.data ?? []).map((entry) =>
        entry.uuid === target.uuid ? { ...entry, level } : entry,
      ),
      `Updated ${target.name}'s operator level`,
    );
  }

  function removeOp(target: OpEntry) {
    void saveOps(
      (opsQuery.data ?? []).filter((entry) => entry.uuid !== target.uuid),
      `Removed ${target.name} from ops`,
    );
  }

  const entries = opsQuery.data ?? [];

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-medium text-[#f2f2f2]">Operators</h3>
          <p className="text-xs text-[#888]">Manage op level and elevated access.</p>
        </div>
        <div className="flex gap-2">
          <input
            value={opName}
            onChange={(event) => setOpName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addOp();
              }
            }}
            placeholder="Player name"
            className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
          />
          <button
            type="button"
            onClick={addOp}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#1a1a1a] px-3 py-2 text-sm text-[#f2f2f2] disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </button>
        </div>
      </div>

      {opsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading operators…
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#2a2a2a] p-4 text-sm text-[#888]">
          No operators configured.
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.uuid || entry.name}
              className="flex flex-col gap-3 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[#2a2a2a] bg-[#151515] text-[#f2f2f2]">
                  <Shield className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm text-[#f2f2f2]">{entry.name}</div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[#888]">
                    <span className={`rounded-full border px-2 py-0.5 ${LEVEL_STYLES[entry.level] ?? LEVEL_STYLES[1]}`}>
                      Level {entry.level}
                    </span>
                    {entry.bypassesPlayerLimit ? <span>Bypasses player limit</span> : null}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  value={entry.level}
                  onChange={(event) => updateLevel(entry, Number(event.target.value))}
                  disabled={saving}
                  className="rounded-lg border border-[#2a2a2a] bg-[#111] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none"
                >
                  {[1, 2, 3, 4].map((level) => (
                    <option key={level} value={level}>
                      Level {level}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeOp(entry)}
                  disabled={saving}
                  className="rounded-lg p-2 text-[#888] transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
