import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerDeployment, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

async function readWhitelist(name: string) {
  const clients = makeGameHubClients();
  const deployment = await getServerDeployment(clients.appsApi, name);
  const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
  if (gameType.toLowerCase().includes("minecraft")) {
    const [playersResult, propsResult] = await Promise.all([
      runServerCommand(clients, name, "cat /data/whitelist.json", 10_000).catch(() => ({ stdout: "[]", stderr: "" })),
      runServerCommand(clients, name, "cat /data/server.properties", 10_000).catch(() => ({ stdout: "", stderr: "" })),
    ]);
    const players = JSON.parse(playersResult.stdout || "[]") as Array<{ name?: string }>;
    const enabled = /white-list\s*=\s*true/i.test(propsResult.stdout);
    return { enabled, players: players.map((entry) => entry.name ?? "").filter(Boolean), gameType };
  }

  const result = await runServerCommand(clients, name, "cat /data/whitelist.txt", 10_000).catch(() => ({ stdout: "", stderr: "" }));
  return { enabled: true, players: result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), gameType };
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
    return NextResponse.json(await readWhitelist(name));
  } catch (error) {
    console.error("whitelist route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-whitelist-post", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { action?: "add" | "remove" | "toggle"; player?: string; enabled?: boolean };
  if (!body.action) return NextResponse.json({ error: "action is required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    if (body.action === "toggle") {
      await runServerCommand(clients, name, body.enabled ? "whitelist on" : "whitelist off", 10_000);
    } else if (body.player) {
      await runServerCommand(clients, name, `whitelist ${body.action} ${body.player}`, 10_000);
    } else {
      return NextResponse.json({ error: "player is required" }, { status: 400 });
    }
    return NextResponse.json(await readWhitelist(name));
  } catch (error) {
    console.error("whitelist mutation failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
