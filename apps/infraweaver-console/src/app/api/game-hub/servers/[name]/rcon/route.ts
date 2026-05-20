import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { isServerStartingError, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const MAX_COMMAND_LENGTH = 512;
const rconBodySchema = z.object({
  command: z.string().min(1).max(500),
}).strict();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:console",
      name,
    )
  ) {
    await auditUnauthorizedAccess("game-hub:rcon-denied", req, session.user?.email ?? "unknown", `${name} missing game-hub:console`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = rconBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const sanitized = sanitizeConsoleCommand(result.data.command);
  if (!sanitized.ok) return NextResponse.json({ error: sanitized.error }, { status: 400 });
  const input = sanitized.value;
  if (input.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json(
      { error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` },
      { status: 400 },
    );
  }

  try {
    const clients = makeGameHubClients();
    const commandResult = await runServerCommand(clients, name, input);
    await auditLog("game-hub:rcon", session.user?.email ?? "unknown", `${name} — ${input}`);

    return NextResponse.json({
      output: commandResult.stdout.trim() || commandResult.stderr.trim(),
      ...(commandResult.stderr.trim() ? { error: commandResult.stderr.trim() } : {}),
      method: commandResult.method,
      gameType: commandResult.gameType,
    });
  } catch (error) {
    console.error("rcon route failed", error);
    if (isServerStartingError(error)) {
      return NextResponse.json({ error: "Server is starting up, please wait...", output: "" }, { status: 503 });
    }
    return NextResponse.json({ error: safeError(error), output: "" }, { status: 500 });
  }
}
