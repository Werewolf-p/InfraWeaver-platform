import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { banCommandForGame, kickCommandForGame, listCommandForGame, parsePlayerIpMap, parsePlayerNames, resolveCountryCode } from "@/lib/game-hub-players";
import { appendServerAudit, GAME_HUB_NS, getServerDeployment, getServerPod, makeGameHubClients, parsePlayerHistory, runServerCommand, trimPlayerHistory, withGameHubAuth } from "@/lib/game-hub-server";
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

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ req, name }) => {
  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    // Player tracking runs `list` on the game server, which floods the server log
    // when polled continuously. It is OPT-IN: the command only runs when the client
    // explicitly asks for live data (?live=1). Default polls return history only and
    // never touch the server, so the console no longer spams `list` every 30s.
    const live = new URL(req.url).searchParams.get("live") === "1";
    // Track whether the live `list` command actually SUCCEEDED. A failed command
    // (RCON down, server starting) must NOT be treated as "0 players" — that would
    // falsely trip the auto-pause bookkeeping and stop a populated server.
    let commandSucceeded = false;
    let commandOutput: { stdout: string; stderr: string; gameType: string } = { stdout: "", stderr: "", gameType };
    if (live) {
      try {
        const res = await runServerCommand(clients, name, listCommandForGame(gameType), 10_000);
        commandOutput = { stdout: res.stdout, stderr: res.stderr, gameType };
        commandSucceeded = true;
      } catch {
        commandSucceeded = false;
      }
    }
    const names = parsePlayerNames(gameType, commandOutput.stdout || commandOutput.stderr);
    const history = parsePlayerHistory(deployment.metadata?.annotations?.["infraweaver/player-history"]);
    const pod = await getServerPod(clients.coreApi, name, true);
    const logs = pod?.metadata?.name
      ? await clients.coreApi.readNamespacedPodLog({ name: pod.metadata.name, namespace: GAME_HUB_NS, container: pod.spec?.containers?.[0]?.name ?? name, tailLines: 300 }) as string
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
    // Only touch the auto-pause markers when we have real (live) player data AND the
    // list command succeeded — otherwise a non-live poll or a failed command would
    // report 0 players and wrongly mark the server empty.
    const autoPauseEnabled = deployment.metadata?.annotations?.["infraweaver/autopause-enabled"] === "true";
    if (live && commandSucceeded && autoPauseEnabled) {
      const emptySince = deployment.metadata?.annotations?.["infraweaver/players-empty-since"];
      if (players.length > 0 && emptySince) {
        // Players are back — clear the empty-since marker.
        void clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: GAME_HUB_NS,
          body: { metadata: { annotations: { "infraweaver/players-empty-since": "" } } },
          fieldManager: "infraweaver",
        });
      } else if (players.length === 0 && !emptySince) {
        // Server just became empty — record the timestamp.
        void clients.appsApi.patchNamespacedDeployment({
          name,
          namespace: GAME_HUB_NS,
          body: { metadata: { annotations: { "infraweaver/players-empty-since": new Date().toISOString() } } },
          fieldManager: "infraweaver",
        });
      }
    }

    return NextResponse.json({ players, count: players.length, history, gameType, live });
  } catch (error) {
    console.error("players route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const POST = withGameHubAuth(
  { permission: "game-hub:write", rateLimit: { name: "game-hub-player-post", limit: 20, windowMs: 60_000 } },
  async ({ req, session, name }) => {
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
  },
);

export const PATCH = withGameHubAuth(
  { permission: "game-hub:write", rateLimit: { name: "game-hub-player-patch", limit: 30, windowMs: 60_000 } },
  async ({ req, name }) => {
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
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "infraweaver/player-history": JSON.stringify(history) } } },
        fieldManager: "infraweaver",

      });
      return NextResponse.json({ history });
    } catch (error) {
      console.error("record player count failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
