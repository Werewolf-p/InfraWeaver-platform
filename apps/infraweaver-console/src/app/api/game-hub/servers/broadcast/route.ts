import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { sanitizeConsoleCommand } from "@/lib/api-helpers";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { makeGameHubClients, runServerCommand } from "@/lib/game-hub-server";
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
  const clients = makeGameHubClients();
  const results = await Promise.all(parsed.data.servers.map(async (serverName) => {
    if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:console", serverName)) {
      return { server: serverName, output: "", error: "Forbidden" };
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

  return NextResponse.json({ results });
}
