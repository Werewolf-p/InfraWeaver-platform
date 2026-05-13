import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

const MAX_COMMAND_LENGTH = 512;

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

  const body = (await req.json()) as { command?: string };
  const sanitized = sanitizeConsoleCommand(body.command ?? "");
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
    const result = await runServerCommand(clients, name, input);
    await auditLog("game-hub:rcon", session.user?.email ?? "unknown", `${name} — ${input}`);

    return NextResponse.json({
      output: result.stdout.trim() || result.stderr.trim(),
      ...(result.stderr.trim() ? { error: result.stderr.trim() } : {}),
    });
  } catch (error) {
    console.error("rcon route failed", error);
    return NextResponse.json({ error: safeError(error), output: "" }, { status: 500 });
  }
}
