"use client";

import { useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "@/lib/notify";
import type { ServerDetail } from "./types";
import { fetchJson } from "./utils";

interface RconPanelProps {
  serverName: string;
  gameType: string;
  permissions: ServerDetail["permissions"];
}

interface HistoryEntry {
  id: string;
  command: string;
  output: string;
  error?: string;
  createdAt: number;
}

const MINECRAFT_QUICK_COMMANDS = [
  "/list",
  "/weather clear",
  "/time set day",
  "/difficulty peaceful",
  "/gamemode survival @a",
  "/seed",
];

function isMinecraft(gameType: string) {
  return (gameType ?? "").toLowerCase().includes("minecraft");
}

export function RconPanel({ serverName, gameType, permissions }: RconPanelProps) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const canConsole = permissions?.canConsole ?? false;
  const quickCommands = useMemo(
    () => (isMinecraft(gameType) ? MINECRAFT_QUICK_COMMANDS : []),
    [gameType],
  );

  async function sendCommand(nextCommand?: string) {
    const value = (nextCommand ?? command).trim();
    if (!value) return;
    setSubmitting(true);
    try {
      const response = await fetchJson<{ output: string; error?: string }>(
        `/api/game-hub/servers/${serverName}/rcon`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: value }),
        },
      );
      const entry: HistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: value,
        output: response.output,
        error: response.error,
        createdAt: Date.now(),
      };
      setHistory((current) => [...current, entry].slice(-20));
      if (response.error) toast.error(response.error);
      else toast.success("Command sent");
      setCommand("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setHistory((current) =>
        [
          ...current,
          {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            command: value,
            output: "",
            error: message,
            createdAt: Date.now(),
          },
        ].slice(-20),
      );
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#2a2a2a] bg-[#111] p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-[#f2f2f2]">RCON Console</h3>
        <p className="text-xs text-[#888]">
          Send remote console commands and review the last 20 responses.
        </p>
      </div>

      {quickCommands.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {quickCommands.map((quickCommand) => (
            <button
              key={quickCommand}
              type="button"
              disabled={!canConsole || submitting}
              onClick={() => void sendCommand(quickCommand)}
              className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-1.5 text-xs text-[#f2f2f2] transition hover:border-[#3a3a3a] disabled:opacity-50"
            >
              {quickCommand}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex gap-2">
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void sendCommand();
            }
          }}
          disabled={!canConsole || submitting}
          placeholder={canConsole ? "Enter an RCON command" : "Console access is disabled"}
          className="flex-1 rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-[#f2f2f2] focus:border-[#0078D4] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void sendCommand()}
          disabled={!canConsole || submitting || !command.trim()}
          className="inline-flex items-center gap-2 rounded-lg bg-[#0078D4] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Send
        </button>
      </div>

      {!canConsole ? (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200">
          Your account does not have console permission for this server.
        </div>
      ) : null}

      <div className="space-y-2">
        {history.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#2a2a2a] p-4 text-sm text-[#888]">
            No RCON commands sent yet.
          </div>
        ) : (
          history
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.id} className="rounded-lg border border-[#2a2a2a] bg-[#0a0a0a] p-3">
                <div className="flex items-center justify-between gap-3 text-xs text-[#888]">
                  <span className="font-mono text-[#f2f2f2]">{entry.command}</span>
                  <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                </div>
                <pre
                  className={`mt-2 whitespace-pre-wrap break-words font-mono text-xs ${
                    entry.error ? "text-red-300" : "text-green-300"
                  }`}
                >
                  {entry.error || entry.output || "(no output)"}
                </pre>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
