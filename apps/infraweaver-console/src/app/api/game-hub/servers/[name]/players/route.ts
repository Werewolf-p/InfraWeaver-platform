import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { banCommandForGame, kickCommandForGame, listCommandForGame, parsePlayerIpMap, parsePlayerNames, resolveCountryCode } from "@/lib/game-hub-players";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, getServerDeployment, makeGameHubClients, parsePlayerHistory, readServerEgg, runServerCommand, trimPlayerHistory } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const playerActionSchema = z.object({
  action: z.enum(["kick", "ban"]),
  player: z.string().min(1),
  reason: z.string().optional(),
});

const playerRecordSchema = z.object({
  action: z.literal("record-count"),
  count: z.number().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    const commandOutput = await runServerCommand(clients, name, listCommandForGame(gameType), 10_000).catch(() => ({ stdout: "", stderr: "", gameType }));
    const names = parsePlayerNames(gameType, commandOutput.stdout || commandOutput.stderr);
    const history = parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]);
    const pod = await import("@/lib/game-hub-server").then(({ getServerPod }) => getServerPod(clients.coreApi, name, true));
    const logs = pod?.metadata?.name
      ? await clients.coreApi.readNamespacedPodLog({ name: pod.metadata.name, namespace: "game-hub", container: pod.spec?.containers?.[0]?.name ?? name, tailLines: 300 }) as string
      : "";
    const ipMap = parsePlayerIpMap(logs);

    const players = await Promise.all(names.map(async (player) => {
      const ip = ipMap.get(player) ?? null;
      const countryCode = ip ? await resolveCountryCode(ip) : null;
      return {
        name: player,
        ip,
        countryCode,
        group: "Online",
      };
    }));

    // Auto-pause tracking: keep "players-empty-since" annotation in sync so the status poller
    // can scale to 0 when the server has been empty for the configured duration.
    const autoPauseEnabled = deployment.metadata?.annotations?.["infraweaver/autopause-enabled"] === "true";
    if (autoPauseEnabled) {
      const emptySince = deployment.metadata?.annotations?.["infraweaver/players-empty-since"];
      if (players.length > 0 && emptySince) {
        // Players are back — clear the empty-since marker.
        void clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: "game-hub",
          body: { metadata: { annotations: { "infraweaver/players-empty-since": "" } } },
          fieldManager: "infraweaver",
        });
      } else if (players.length === 0 && !emptySince) {
        // Server just became empty — record the timestamp.
        void clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: "game-hub",
          body: { metadata: { annotations: { "infraweaver/players-empty-since": new Date().toISOString() } } },
          fieldManager: "infraweaver",
        });
      }
    }

    return NextResponse.json({ players, count: players.length, history, gameType });
  } catch (error) {
    console.error("players route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-player-post", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = playerActionSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const body = parsedBody.data;

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    const command = body.action === "kick"
      ? kickCommandForGame(gameType, body.player, body.reason)
      : banCommandForGame(gameType, body.player, body.reason);
    const result = await runServerCommand(clients, name, command, 10_000);
    await auditLog(`game-hub:player-${body.action}`, session.user?.email ?? "unknown", `${body.action} ${body.player} on ${name}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: `player:${body.action}`, details: `${body.player} ${body.reason ?? ""}`.trim() });
    return NextResponse.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    console.error("player action failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-player-patch", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr3 = validateK8sName(name);
  if (nameErr3) return NextResponse.json(nameErr3.error, { status: nameErr3.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawPatch = await req.json().catch(() => null);
  const parsedPatch = playerRecordSchema.safeParse(rawPatch);
  if (!parsedPatch.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedPatch.error.flatten() }, { status: 400 });
  }
  const body = parsedPatch.data;

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const current = parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]);
    const history = trimPlayerHistory([...current, { t: Date.now(), n: Math.max(0, body.count ?? 0) }]);
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: "game-hub",
      body: { metadata: { annotations: { "infraweaver/player-history": JSON.stringify(history) } } },
      fieldManager: "infraweaver",

    });
    return NextResponse.json({ history });
  } catch (error) {
    console.error("record player count failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
