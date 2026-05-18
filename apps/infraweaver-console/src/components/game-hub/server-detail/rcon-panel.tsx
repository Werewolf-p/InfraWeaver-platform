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

interface CommandResponse {
  output: string;
  error?: string;
  method?: string;
  gameType?: string;
}

const MINECRAFT_QUICK_COMMANDS = [
  "/list",
  "/weather clear",
  "/time set day",
  "/difficulty peaceful",
  "/gamemode survival @a",
  "/seed",
];

function normalizeGameType(gameType: string) {
  return (gameType ?? "").toLowerCase();
}

function isMinecraft(gameType: string) {
  return normalizeGameType(gameType).includes("minecraft");
}

function isTerraria(gameType: string) {
  return normalizeGameType(gameType) === "terraria";
}

function isValheim(gameType: string) {
  return normalizeGameType(gameType) === "valheim";
}

function isRust(gameType: string) {
  return normalizeGameType(gameType) === "rust";
}

function isSourceGame(gameType: string) {
  return ["cs2", "csgo", "tf2"].includes(normalizeGameType(gameType));
}

function getPanelTitle(gameType: string) {
  return isMinecraft(gameType) || isSourceGame(gameType) || isRust(gameType) || isValheim(gameType)
    ? "RCON Console"
    : "Console Commands";
}

function getPanelDescription(gameType: string) {
  if (isTerraria(gameType)) return "Terraria sends commands over stdin to the server process.";
  if (isValheim(gameType)) return "Valheim tries localhost:2458 RCON first, then falls back to stdin.";
  if (isMinecraft(gameType)) return "Minecraft tries mcrcon/RCON first, then falls back to the server console pipe.";
  if (isRust(gameType) || isSourceGame(gameType)) return "Uses localhost RCON first, then falls back to stdin when available.";
  return "Send console commands and review the last 20 responses.";
}

function getCommandPlaceholder(gameType: string) {
  if (isTerraria(gameType)) return "Enter a Terraria console command";
  if (isValheim(gameType)) return "Enter a Valheim console command";
  return "Enter a console command";
}

function isTransportFailure(message: string) {
  return [
    "can't connect rcon",
    "rcon client is unavailable",
    "connection refused",
    "connection reset",
    "timed out",
    "authentication",
    "bad password",
    "wrong password",
    "no supported stdin console input method found",
  ].some((entry) => message.includes(entry));
}

function formatCommandError(gameType: string, rawMessage: string) {
  const message = rawMessage.trim();
  const lower = message.toLowerCase();
  if (!isTransportFailure(lower)) return message;
  if (isTerraria(gameType)) return "Terraria commands use stdin. Make sure the server is running and its console pipe is attached.";
  if (isValheim(gameType)) return "Valheim command delivery failed. Check ENABLE_RCON=1, SERVER_RCON_PASSWORD, and RCON_PORT=2458, or make sure stdin is available.";
  if (isMinecraft(gameType)) return "Minecraft command delivery failed. Check ENABLE_RCON, RCON_PASSWORD, and RCON_PORT=25575, or make sure the console pipe is available.";
  if (isRust(gameType)) return "Rust command delivery failed. Check RCON_PASSWORD and RCON_PORT=28016, or make sure stdin is available.";
  if (isSourceGame(gameType)) return "Source server command delivery failed. Check SRCDS_RCONPW and SRCDS_PORT, or make sure stdin is available.";
  return message;
}

function getSuccessMessage(gameType: string, method?: string) {
  if (method === "stdin") {
    return isTerraria(gameType) ? "Command sent via Terraria stdin" : "Command sent via server console";
  }
  if (method === "mcrcon") return "Command sent via mcrcon";
  if (method === "rcon") return "Command sent via RCON";
  return "Command sent";
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
      const response = await fetchJson<CommandResponse>(
        `/api/game-hub/servers/${serverName}/rcon`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: value }),
        },
      );
      const errorMessage = response.error ? formatCommandError(gameType, response.error) : undefined;
      const entry: HistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command: value,
        output: response.output,
        error: errorMessage,
        createdAt: Date.now(),
      };
      setHistory((current) => [...current, entry].slice(-20));
      if (errorMessage) toast.error(errorMessage);
      else toast.success(getSuccessMessage(gameType, response.method));
      setCommand("");
    } catch (error) {
      const message = formatCommandError(gameType, error instanceof Error ? error.message : String(error));
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
        <h3 className="text-sm font-medium text-[#f2f2f2]">{getPanelTitle(gameType)}</h3>
        <p className="text-xs text-[#888]">{getPanelDescription(gameType)}</p>
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
          placeholder={canConsole ? getCommandPlaceholder(gameType) : "Console access is disabled"}
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
            No console commands sent yet.
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
