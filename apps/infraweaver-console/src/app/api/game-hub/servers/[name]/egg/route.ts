import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildEggConfigMap, getEggForGameType, type GameEgg } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission, parseEggConfig } from "@/lib/game-hub";
import { writeServerManifest } from "@/lib/game-hub-manifest";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

function deploymentGameType(deployment: { metadata?: { labels?: Record<string, string> } } | null | undefined) {
  return deployment?.metadata?.labels?.["infraweaver/game-type"] ?? deployment?.metadata?.labels?.["infraweaver.io/game-type"] ?? "unknown";
}

async function readEgg(coreApi: import("@kubernetes/client-node").CoreV1Api, name: string, deployment?: { metadata?: { labels?: Record<string, string> } }) {
  try {
    const configMap = await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE });
    return parseEggConfig(configMap.data?.["egg.json"], deploymentGameType(deployment));
  } catch {
    return getEggForGameType(deploymentGameType(deployment));
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const appsApi = clients.appsApi;
    const coreApi = clients.coreApi;
    let deployment = null;
    try {
      deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    } catch {}
    return NextResponse.json({ egg: await readEgg(coreApi, name, deployment ?? undefined) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { egg?: Partial<GameEgg> };
  if (!body.egg) return NextResponse.json({ error: "egg payload required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const appsApi = clients.appsApi;
    const coreApi = clients.coreApi;
    let deployment = null;
    try {
      deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    } catch {}

    const existingEgg = await readEgg(coreApi, name, deployment ?? undefined);
    const mergedEgg: GameEgg = {
      ...existingEgg,
      ...body.egg,
      environment: body.egg.environment ?? existingEgg.environment,
      quickCommands: body.egg.quickCommands ?? existingEgg.quickCommands,
    };

    const configMap = buildEggConfigMap(GAME_HUB_NAMESPACE, name, mergedEgg);
    try {
      await coreApi.readNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE });
      await coreApi.replaceNamespacedConfigMap({ name: `gameserver-${name}-egg`, namespace: GAME_HUB_NAMESPACE, body: configMap });
    } catch {
      await coreApi.createNamespacedConfigMap({ namespace: GAME_HUB_NAMESPACE, body: configMap });
    }

    try {
      await writeServerManifest(name, clients);
    } catch (gitErr) {
      console.warn(`writeServerManifest failed after egg update for ${name}`, gitErr);
    }

    return NextResponse.json({ ok: true, egg: mergedEgg });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
