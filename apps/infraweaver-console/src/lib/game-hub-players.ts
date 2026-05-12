export interface PlayerActivityEntry {
  player: string;
  time: string;
}

export interface ChatMessage {
  player: string;
  message: string;
  timestamp: string;
}

export function listCommandForGame(gameType: string) {
  const normalized = gameType.toLowerCase();
  if (["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"].includes(normalized)) return "list";
  if (normalized === "terraria") return "playing";
  if (normalized === "valheim") return "players";
  return "list";
}

export function kickCommandForGame(gameType: string, player: string, reason?: string) {
  const suffix = reason?.trim() ? ` ${reason.trim()}` : "";
  const normalized = gameType.toLowerCase();
  if (["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"].includes(normalized)) return `kick ${player}${suffix}`;
  if (normalized === "terraria") return `kick ${player}${suffix}`;
  return `kick ${player}${suffix}`;
}

export function banCommandForGame(gameType: string, player: string, reason?: string) {
  const suffix = reason?.trim() ? ` ${reason.trim()}` : "";
  const normalized = gameType.toLowerCase();
  if (["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"].includes(normalized)) return `ban ${player}${suffix}`;
  return `ban ${player}${suffix}`;
}

export function pardonCommandForGame(gameType: string, player: string) {
  const normalized = gameType.toLowerCase();
  if (["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"].includes(normalized)) return `pardon ${player}`;
  return `pardon ${player}`;
}

export function parsePlayerNames(gameType: string, output: string) {
  const normalized = gameType.toLowerCase();
  const line = output.trim();
  if (["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"].includes(normalized)) {
    const match = line.match(/players online:?\s*(.*)$/i) ?? line.match(/online:\s*(.*)$/i);
    const names = (match?.[1] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const countMatch = line.match(/There are\s+(\d+)/i);
    if ((countMatch?.[1] ?? "0") === "0") return [];
    return names;
  }

  if (normalized === "terraria") {
    return line.split(/[:,]/).slice(1).map((entry) => entry.trim()).filter(Boolean);
  }

  return line.split(/[,\n]/).map((entry) => entry.trim()).filter((entry) => !!entry && !/players?/i.test(entry));
}

export function parsePlayerIpMap(logContent: string) {
  const mapping = new Map<string, string>();
  for (const line of logContent.split("\n")) {
    const minecraftMatch = line.match(/\]:\s*([^\[]+)\[\/(\d+\.\d+\.\d+\.\d+)/);
    if (minecraftMatch) {
      mapping.set(minecraftMatch[1]?.trim() ?? "", minecraftMatch[2] ?? "");
      continue;
    }
    const genericMatch = line.match(/player\s+([^\s]+).*?(\d+\.\d+\.\d+\.\d+)/i);
    if (genericMatch) {
      mapping.set(genericMatch[1] ?? "", genericMatch[2] ?? "");
    }
  }
  return mapping;
}

export function parsePlayerActivity(logContent: string) {
  const recentJoins: PlayerActivityEntry[] = [];
  const recentLeaves: PlayerActivityEntry[] = [];
  const today = new Set<string>();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  for (const line of logContent.split("\n")) {
    const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}[T ][^\s]+)/)?.[1] ?? new Date().toISOString();
    const joinMatch = line.match(/\]:\s*([^\s]+) joined the game/i) ?? line.match(/\]:\s*([^\[]+)\[\/\d+\.\d+\.\d+\.\d+:\d+\] logged in/i);
    if (joinMatch?.[1]) {
      const player = joinMatch[1].trim();
      recentJoins.push({ player, time: timestamp });
      if (new Date(timestamp).getTime() >= dayStart) today.add(player);
      continue;
    }
    const leaveMatch = line.match(/\]:\s*([^\s]+) left the game/i) ?? line.match(/\]:\s*([^\s]+) lost connection/i);
    if (leaveMatch?.[1]) {
      recentLeaves.push({ player: leaveMatch[1].trim(), time: timestamp });
    }
  }

  return {
    recentJoins: recentJoins.slice(-20).reverse(),
    recentLeaves: recentLeaves.slice(-20).reverse(),
    uniqueToday: today.size,
  };
}

export function parseChatMessages(logContent: string): ChatMessage[] {
  return logContent.split("\n").flatMap((line) => {
    const timestamp = line.match(/^(\d{4}-\d{2}-\d{2}[T ][^\s]+)/)?.[1] ?? new Date().toISOString();
    const chatMatch = line.match(/<([^>]+)>\s+(.*)$/);
    if (!chatMatch) return [];
    return [{ player: chatMatch[1] ?? "", message: chatMatch[2] ?? "", timestamp }];
  }).slice(-100).reverse();
}

export async function resolveCountryCode(ip: string) {
  if (!ip) return null;
  try {
    const response = await fetch(`https://ip-api.com/json/${ip}?fields=status,countryCode`, { next: { revalidate: 3600 } });
    if (!response.ok) return null;
    const data = await response.json() as { status?: string; countryCode?: string };
    return data.status === "success" ? (data.countryCode ?? null) : null;
  } catch {
    return null;
  }
}
