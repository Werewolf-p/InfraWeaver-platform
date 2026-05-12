import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import { Writable } from "stream";

const MAX_COMMAND_LENGTH = 512;
const RCON_GAME_TYPES = new Set(["minecraft", "minecraft-java", "minecraft-bedrock", "paper", "spigot", "forge", "fabric"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:console", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { command: string };
  const command = body.command?.trim() ?? "";
  if (!command) return NextResponse.json({ error: "No command provided" }, { status: 400 });
  if (command.length > MAX_COMMAND_LENGTH) return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.find((entry) => entry.status?.phase === "Running") ?? pods.items?.[0];
    const podName = pod?.metadata?.name;
    if (!podName) return NextResponse.json({ error: "No running pod found" }, { status: 404 });

    let gameType = "unknown";
    try {
      const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
      gameType = deployment.metadata?.labels?.["infraweaver/game-type"] ?? "unknown";
    } catch {}

    const exec = new k8s.Exec(kc);
    const execCommand = RCON_GAME_TYPES.has(gameType.toLowerCase()) ? ["rcon-cli", command] : ["sh", "-c", command];
    let stdout = "";
    let stderr = "";

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 10000);
      const stdoutStream = new Writable({ write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); } });
      const stderrStream = new Writable({ write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); } });
      exec.exec(GAME_HUB_NAMESPACE, podName, pod.spec?.containers?.[0]?.name ?? name, execCommand, stdoutStream, stderrStream, null, false, (status) => {
        clearTimeout(timeout);
        if (status?.status === "Failure") reject(new Error(status.message ?? "Command failed"));
        else resolve();
      }).catch(reject);
    });

    return NextResponse.json({ stdout, stderr, success: true, method: RCON_GAME_TYPES.has(gameType.toLowerCase()) ? "rcon" : "shell" });
  } catch (error) {
    return NextResponse.json({ error: safeError(error), stdout: "", stderr: "", success: false }, { status: 500 });
  }
}
