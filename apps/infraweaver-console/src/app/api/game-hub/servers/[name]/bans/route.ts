import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { banCommandForGame, pardonCommandForGame } from "@/lib/game-hub-players";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerDeployment, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

async function readBans(name: string) {
  const clients = makeGameHubClients();
  const result = await runServerCommand(clients, name, "cat /data/banned-players.json", 10_000).catch(() => ({ stdout: "[]", stderr: "" }));
  const bans = JSON.parse(result.stdout || "[]") as Array<{ name?: string; reason?: string; created?: string; source?: string }>;
  return { bans };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json(await readBans(name));
  } catch (error) {
    console.error("bans route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-bans-post", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { action?: "ban" | "pardon"; player?: string; reason?: string };
  if (!body.action || !body.player) return NextResponse.json({ error: "action and player are required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    await runServerCommand(clients, name, body.action === "ban" ? banCommandForGame(gameType, body.player, body.reason) : pardonCommandForGame(gameType, body.player), 10_000);
    return NextResponse.json(await readBans(name));
  } catch (error) {
    console.error("ban mutation failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
