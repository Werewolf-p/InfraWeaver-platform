import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { validateK8sName } from "@/lib/api-security";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, isServerStartingError, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
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
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
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
    const deployment = await clients.appsApi.readNamespacedDeployment({ name, namespace: "game-hub" });
    const rawBlocklist = deployment.metadata?.annotations?.["game-hub/command-blocklist"];
    const parsedBlocklist = (() => {
      if (!rawBlocklist) return [] as string[];
      try {
        const parsed = JSON.parse(rawBlocklist) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === "string")
          : [];
      } catch {
        return [] as string[];
      }
    })();
    const normalizedCommand = input.trim().toLowerCase();
    const blocked = parsedBlocklist.some((entry) => {
      const normalizedEntry = entry.trim().toLowerCase();
      return normalizedEntry.length > 0 && normalizedCommand.startsWith(normalizedEntry);
    });
    if (blocked) {
      return NextResponse.json({ error: "Command blocked by server policy" }, { status: 403 });
    }

    const commandResult = await runServerCommand(clients, name, input);
    await auditLog("game-hub:rcon", session.user?.email ?? "unknown", `${name} — ${input}`);
    void appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action: "rcon:command",
      details: input,
    }).catch(console.error);

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
