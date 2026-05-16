import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { isServerStartingError, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const MAX_COMMAND_LENGTH = 512;
const execBodySchema = z.object({
  command: z.union([
    z.string().min(1).max(500),
    z.array(z.string().min(1).max(200)).min(1).max(20),
  ]),
}).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-exec", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:console", name)) {
    await auditUnauthorizedAccess("game-hub:exec-denied", req, session.user?.email ?? "unknown", `${name} missing game-hub:console`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = execBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const rawCommand = Array.isArray(result.data.command) ? result.data.command.join(" ") : result.data.command;
  const sanitized = sanitizeConsoleCommand(rawCommand);
  if (!sanitized.ok) return NextResponse.json({ error: sanitized.error }, { status: 400 });
  const command = sanitized.value;
  if (command.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    const commandResult = await runServerCommand(clients, name, command);
    await auditLog("game-hub:exec", session.user?.email ?? "unknown", `${name} — ${command}`);
    return NextResponse.json({ stdout: commandResult.stdout, stderr: commandResult.stderr, method: commandResult.method });
  } catch (error) {
    console.error("exec route failed", error);
    if (isServerStartingError(error)) {
      return NextResponse.json({ error: "Server is starting up, please wait..." }, { status: 503 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
