import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, getServerDeployment, isServerStartingError, makeGameHubClients, readServerEgg, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

const MAX_COMMAND_LENGTH = 512;

function allowedForRole(commandAcl: Record<string, string[]> | undefined, roleKey: string) {
  return commandAcl?.[roleKey] ?? [];
}

function isCommandAllowed(command: string, allowed: string[]) {
  if (allowed.includes("*")) return true;
  return allowed.some((entry) => command === entry || command.startsWith(`${entry} `));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-command", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { command: string };
  const command = body.command?.trim() ?? "";
  if (!command) return NextResponse.json({ error: "No command provided" }, { status: 400 });
  if (command.length > MAX_COMMAND_LENGTH) return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const perms = getEffectivePermissions(access.groups, access.username, access.roleAssignments, `/game-hub/servers/${name}`);
    const roleKey = perms.has("*") || perms.has("game-hub:admin")
      ? "game-server-admin"
      : perms.has("game-hub:write") || perms.has("game-hub:console") || perms.has("game-hub:files") || perms.has("game-hub:start") || perms.has("game-hub:stop")
        ? "game-server-operator"
        : "game-server-viewer";
    const allowed = allowedForRole(egg.commandAcl, roleKey);
    if (!isCommandAllowed(command, allowed)) {
      return NextResponse.json({ error: "Command not allowed for your role", stdout: "", stderr: "", success: false }, { status: 403 });
    }

    const result = await runServerCommand(clients, name, command, 10_000);
    await auditLog("game-hub:command", session.user?.email ?? "unknown", `${name} — ${command}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "command", details: command });
    return NextResponse.json({ stdout: result.stdout, stderr: result.stderr, success: true, method: "shell" });
  } catch (error) {
    console.error("game hub command failed", error);
    if (isServerStartingError(error)) {
      return NextResponse.json(
        { error: "Server is starting up, please wait...", stdout: "", stderr: "", success: false },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: safeError(error), stdout: "", stderr: "", success: false }, { status: 500 });
  }
}
