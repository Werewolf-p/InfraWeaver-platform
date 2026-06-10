import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";

const suggestions: Record<string, { cpuPerPlayer: number; ramMBBase: number; ramMBPerPlayer: number; diskGB: number }> = {
  minecraft: { cpuPerPlayer: 0.05, ramMBBase: 1024, ramMBPerPlayer: 50, diskGB: 5 },
  "minecraft-bedrock": { cpuPerPlayer: 0.05, ramMBBase: 512, ramMBPerPlayer: 30, diskGB: 3 },
  terraria: { cpuPerPlayer: 0.03, ramMBBase: 256, ramMBPerPlayer: 20, diskGB: 2 },
  valheim: { cpuPerPlayer: 0.1, ramMBBase: 1536, ramMBPerPlayer: 100, diskGB: 5 },
  rust: { cpuPerPlayer: 0.08, ramMBBase: 2048, ramMBPerPlayer: 80, diskGB: 10 },
  csgo: { cpuPerPlayer: 0.05, ramMBBase: 512, ramMBPerPlayer: 30, diskGB: 5 },
  default: { cpuPerPlayer: 0.05, ramMBBase: 512, ramMBPerPlayer: 40, diskGB: 3 },
};

function formatCpu(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatMemory(valueMb: number) {
  return valueMb >= 1024
    ? `${(valueMb / 1024).toFixed(valueMb % 1024 === 0 ? 0 : 1)}Gi`
    : `${Math.round(valueMb)}Mi`;
}

export const GET = withAuth(
  {
    permission: "game-hub:read",
    scope: "/game-hub/",
    rateLimit: { name: "game-hub-suggest-resources", limit: 20, windowMs: 60_000 },
  },
  async ({ req }) => {
    const gameType = req.nextUrl.searchParams.get("gameType")?.trim().toLowerCase() ?? "default";
    const players = Number.parseInt(req.nextUrl.searchParams.get("players") ?? "0", 10);
    if (!players || players < 1) {
      return NextResponse.json({ error: "players must be a positive integer" }, { status: 400 });
    }

    const profile = suggestions[gameType] ?? suggestions.default;
    const totalCpu = Math.max(0.5, profile.cpuPerPlayer * players);
    const totalRamMb = profile.ramMBBase + profile.ramMBPerPlayer * players;

    return NextResponse.json({
      gameType,
      players,
      recommended: {
        cpu: formatCpu(totalCpu),
        memory: formatMemory(totalRamMb),
        cpuRequest: formatCpu(totalCpu),
        memoryRequest: formatMemory(totalRamMb),
        diskGB: profile.diskGB,
      },
      notes: "Recommendations are starting points. Increase CPU and memory for heavy mods, large worlds, or plugin-heavy servers.",
    });
  },
);
