import { NextResponse } from "next/server";
import { parsePlayerActivity } from "@/lib/game-hub-players";
import { GAME_HUB_NS, getServerPod, makeGameHubClients, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const logs = await clients.coreApi.readNamespacedPodLog({ name: pod.metadata.name, namespace: GAME_HUB_NS, container: pod.spec?.containers?.[0]?.name ?? name, tailLines: 500 }) as string;
    return NextResponse.json(parsePlayerActivity(logs));
  } catch (error) {
    console.error("player stats failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
