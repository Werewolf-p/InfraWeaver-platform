import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { isServerStartingError, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const MAX_COMMAND_LENGTH = 512;

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-exec", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:console", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { command?: string };
  const command = body.command?.trim() ?? "";
  if (!command) return NextResponse.json({ error: "command is required" }, { status: 400 });
  if (command.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    const result = await runServerCommand(clients, name, command);
    return NextResponse.json({ stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    console.error("exec route failed", error);
    if (isServerStartingError(error)) {
      return NextResponse.json({ error: "Server is starting up, please wait..." }, { status: 503 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
