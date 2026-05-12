import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { parsePlayerActivity } from "@/lib/game-hub-players";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerPod, makeGameHubClients } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

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
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const logs = await clients.coreApi.readNamespacedPodLog({ name: pod.metadata.name, namespace: "game-hub", container: pod.spec?.containers?.[0]?.name ?? name, tailLines: 500 }) as string;
    return NextResponse.json(parsePlayerActivity(logs));
  } catch (error) {
    console.error("player stats failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
