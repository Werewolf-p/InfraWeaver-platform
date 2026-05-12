import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { execShell, getPrimaryContainerName, getServerDeployment, getServerPod, makeGameHubClients, readServerEgg, shellQuote } from "@/lib/game-hub-server";
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
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const mountPath = egg.mountPath;
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });

    const result = await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `df -P ${shellQuote(mountPath)} 2>/dev/null | tail -n 1 || du -sh ${shellQuote(mountPath)} 2>/dev/null`,
      10_000,
    );

    const line = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const dfMatch = line.match(/^\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)%/);
    if (dfMatch) {
      return NextResponse.json({ used: dfMatch[1], available: dfMatch[2], percent: Number.parseInt(dfMatch[3] ?? "0", 10), mountPath });
    }

    const duMatch = line.match(/^(\S+)/);
    return NextResponse.json({ used: duMatch?.[1] ?? "0", available: "—", percent: 0, mountPath, raw: line });
  } catch (error) {
    console.error("disk route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
