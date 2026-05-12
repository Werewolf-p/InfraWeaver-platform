import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { Writable } from "stream";

const GAME_HUB_NS = "game-hub";
const MAX_COMMAND_LENGTH = 512;

// Game types that have rcon-cli available (itzg/minecraft-server image)
const RCON_GAME_TYPES = new Set(["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as { command: string };
  const command = body.command?.trim() ?? "";

  if (!command) {
    return NextResponse.json({ error: "No command provided" }, { status: 400 });
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });
  }

  const userEmail = session.user?.email ?? "unknown";
  console.log(`[AUDIT] game-hub exec | user=${userEmail} | server=${name} | command=${command}`);

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);

    const pods = await coreApi.listNamespacedPod({
      namespace: GAME_HUB_NS,
      labelSelector: `app=${name}`,
    });
    const pod = pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0];

    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    }

    // Get game type to decide command method
    let gameType = "unknown";
    try {
      const dep = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
      gameType = dep.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    } catch { /* ignore, fall back to shell */ }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    const exec = new k8s.Exec(kc);
    let stdout = "";
    let stderr = "";

    // For Minecraft-type servers: use rcon-cli (sends command to running game process)
    // For others: use sh -c (shell access for admin/debugging)
    const useRcon = RCON_GAME_TYPES.has(gameType.toLowerCase());
    const execCmd = useRcon
      ? ["rcon-cli", command]
      : ["sh", "-c", command];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 10000);

      const stdoutStream = new Writable({
        write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); },
      });
      const stderrStream = new Writable({
        write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); },
      });

      exec.exec(
        GAME_HUB_NS, podName, containerName,
        execCmd,
        stdoutStream, stderrStream, null, false,
        (status) => {
          clearTimeout(timeout);
          if (status?.status === "Failure") reject(new Error(status.message ?? "Command failed"));
          else resolve();
        },
      ).catch(reject);
    });

    return NextResponse.json({ stdout, stderr, success: true, method: useRcon ? "rcon" : "shell" });
  } catch (err) {
    console.error(`[game-hub] exec failed | server=${name} | command=${command} |`, err);
    return NextResponse.json({ error: String(err), stdout: "", stderr: "", success: false }, { status: 500 });
  }
}
