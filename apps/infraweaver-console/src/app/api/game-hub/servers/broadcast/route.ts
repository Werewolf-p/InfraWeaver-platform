import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog, auditUnauthorizedAccess } from "@/lib/audit-log";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { assertCommandAllowed, makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const broadcastBodySchema = z.object({
  servers: z.array(z.string().min(1)).min(1).max(20),
  command: z.string().min(1).max(500),
}).strict();

export async function POST(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("game-hub-broadcast", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawBody = await req.json().catch(() => null);
  const parsed = broadcastBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const invalid = parsed.data.servers
    .map((serverName) => ({ serverName, error: validateK8sName(serverName) }))
    .find((entry) => entry.error);
  if (invalid?.error) {
    return NextResponse.json(invalid.error.error, { status: invalid.error.status });
  }

  const sanitized = sanitizeConsoleCommand(parsed.data.command);
  if (!sanitized.ok) {
    return NextResponse.json({ error: sanitized.error }, { status: 400 });
  }

  const access = await getGameHubAccessContext(session, 60);
  const actor = session.user?.email ?? "unknown";
  const clients = makeGameHubClients();
  const results = await Promise.all(parsed.data.servers.map(async (serverName) => {
    if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:console", serverName)) {
      await auditUnauthorizedAccess("game-hub:broadcast-denied", req, actor, `${serverName} missing game-hub:console`);
      return { server: serverName, output: "", error: "Forbidden" };
    }

    // H2 (SECURITY-SCAN-2026-07-08): broadcast is NOT a policy bypass — enforce
    // the same per-server deployment blocklist + egg per-role command ACL that
    // /exec, /command, and /rcon apply. Denied servers report the reason and the
    // command never runs against them.
    const guard = await assertCommandAllowed(clients, serverName, sanitized.value, {
      groups: access.groups,
      username: access.username,
      roleAssignments: access.roleAssignments,
    });
    if (!guard.allowed) {
      await auditUnauthorizedAccess(`game-hub:broadcast-${guard.reason}-denied`, req, actor, `${serverName} denied command ${sanitized.value}`);
      return { server: serverName, output: "", error: guard.message };
    }

    try {
      const result = await runServerCommand(clients, serverName, sanitized.value);
      const output = result.stdout.trim() || result.stderr.trim();
      return result.stderr.trim()
        ? { server: serverName, output, error: result.stderr.trim() }
        : { server: serverName, output };
    } catch (error) {
      return { server: serverName, output: "", error: safeError(error) };
    }
  }));

  const executed = results.filter((r) => !r.error).map((r) => r.server);
  if (executed.length > 0) {
    await auditLog("game-hub:broadcast", actor, `${sanitized.value} — [${executed.join(", ")}]`);
  }

  return NextResponse.json({ results });
}
