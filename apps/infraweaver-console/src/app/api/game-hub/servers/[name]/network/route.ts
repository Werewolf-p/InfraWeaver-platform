import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { execShell, getPrimaryContainerName, getServerPod, makeGameHubClients } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

function parseNetworkStats(output: string) {
  return output
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [ifaceRaw, valuesRaw] = line.split(":");
      if (!ifaceRaw || !valuesRaw) return [];
      const values = valuesRaw.trim().split(/\s+/);
      return [{
        iface: ifaceRaw.trim(),
        rxBytes: Number.parseInt(values[0] ?? "0", 10) || 0,
        rxPackets: Number.parseInt(values[1] ?? "0", 10) || 0,
        txBytes: Number.parseInt(values[8] ?? "0", 10) || 0,
        txPackets: Number.parseInt(values[9] ?? "0", 10) || 0,
      }];
    });
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
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), "cat /proc/net/dev", 10_000);
    return NextResponse.json({ stats: parseNetworkStats(result.stdout) });
  } catch (error) {
    console.error("network stats failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
