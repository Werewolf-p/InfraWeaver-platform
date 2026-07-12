import { NextResponse } from "next/server";
import { execShell, getPrimaryContainerName, getServerDeployment, getServerPod, makeGameHubClients, readServerEgg, shellQuote, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
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
      `df -h ${shellQuote(mountPath)} 2>/dev/null && echo '---' && du -sh /* 2>/dev/null | sort -rh | head -20`,
      15_000,
    );

    const output = result.stdout.trim();
    const parts = output.split(/\n---\n/);
    const dfSection = parts[0] ?? "";
    const duSection = parts[1] ?? "";

    const dfLines = dfSection.split("\n").filter(Boolean);
    const dfDataLine = dfLines.find((l) => !l.startsWith("Filesystem"));
    const dfMatch = dfDataLine?.match(/^\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+\S+$/);

    const filesystem = dfMatch
      ? { total: dfMatch[1] ?? "?", used: dfMatch[2] ?? "?", available: dfMatch[3] ?? "?", percent: Number.parseInt(dfMatch[4] ?? "0", 10), mountPath }
      : { total: "?", used: "?", available: "?", percent: 0, mountPath, raw: dfSection };

    const topDirs = duSection
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\S+)\s+(\/\S*)$/);
        return m ? { size: m[1] ?? "", path: m[2] ?? "" } : null;
      })
      .filter((entry): entry is { size: string; path: string } => entry !== null);

    return NextResponse.json({ filesystem, topDirs });
  } catch (error) {
    console.error("disk route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
