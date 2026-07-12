import { NextResponse } from "next/server";
import { execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

function parsePsAux(output: string) {
  return output
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0] ?? "",
        pid: parts[1] ?? "",
        cpu: Number.parseFloat(parts[2] ?? "0") || 0,
        mem: Number.parseFloat(parts[3] ?? "0") || 0,
        command: parts.slice(10).join(" ") || parts.slice(4).join(" "),
      };
    })
    .sort((left, right) => right.cpu - left.cpu || right.mem - left.mem)
    .slice(0, 30);
}

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), "ps aux", 10_000);
    return NextResponse.json({ processes: parsePsAux(result.stdout) });
  } catch (error) {
    console.error("process list failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
