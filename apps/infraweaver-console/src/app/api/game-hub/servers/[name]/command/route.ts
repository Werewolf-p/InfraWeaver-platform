import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { validateK8sName } from "@/lib/api-security";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, getServerDeployment, isKubernetesNotFoundError, isServerStartingError, makeGameHubClients, readServerEgg, runServerCommand } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getEffectivePermissions } from "@/lib/rbac";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const MAX_COMMAND_LENGTH = 512;
const commandBodySchema = z.object({
  command: z.string().min(1).max(1000),
}).strict();

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
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    await auditUnauthorizedAccess("game-hub:command-denied", req, session.user?.email ?? "unknown", `${name} missing game-hub:read`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = commandBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const sanitized = sanitizeConsoleCommand(result.data.command);
  if (!sanitized.ok) return NextResponse.json({ error: sanitized.error }, { status: 400 });
  const command = sanitized.value;
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
      await auditUnauthorizedAccess("game-hub:command-acl-denied", req, session.user?.email ?? "unknown", `${name} denied command ${command}`);
      return NextResponse.json({ error: "Command not allowed for your role", stdout: "", stderr: "", success: false }, { status: 403 });
    }

    const commandResult = await runServerCommand(clients, name, command, 10_000);
    await auditLog("game-hub:command", session.user?.email ?? "unknown", `${name} — ${command}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "command", details: command });
    return NextResponse.json({ stdout: commandResult.stdout, stderr: commandResult.stderr, success: true, method: commandResult.method });
  } catch (error) {
    console.error("game hub command failed", error);
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found", stdout: "", stderr: "", success: false }, { status: 404 });
    }
    if (isServerStartingError(error)) {
      return NextResponse.json(
        { error: "Server is starting up, please wait...", stdout: "", stderr: "", success: false },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: safeError(error), stdout: "", stderr: "", success: false }, { status: 500 });
  }
}
