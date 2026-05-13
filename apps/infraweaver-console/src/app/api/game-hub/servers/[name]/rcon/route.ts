import { NextRequest, NextResponse } from "next/server";
import { Writable } from "stream";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";

const MAX_COMMAND_LENGTH = 512;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function execCommand(
  kc: import("@kubernetes/client-node").KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  command: string[],
) {
  const k8s = await import("@kubernetes/client-node");
  const exec = new k8s.Exec(kc);
  let stdout = "";
  let stderr = "";
  let resolved = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (resolved) return;
      resolved = true;
      if (error) reject(error);
      else resolve();
    };

    const stdoutStream = new Writable({
      write(chunk, _encoding, callback) {
        stdout += chunk.toString();
        callback();
      },
    });
    const stderrStream = new Writable({
      write(chunk, _encoding, callback) {
        stderr += chunk.toString();
        callback();
      },
    });

    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          if (status?.status === "Failure") {
            finish(new Error(status.message ?? "RCON exec failed"));
            return;
          }
          finish();
        },
      )
      .then((ws) => {
        ws.on("close", () => finish());
        ws.on("error", (error: Error) => finish(error));
      })
      .catch((error: Error) => finish(error));
  });

  return { stdout, stderr };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (
    !hasGameHubPermission(
      access.groups,
      access.username,
      access.roleAssignments,
      "game-hub:console",
      name,
    )
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json()) as { command?: string };
  const input = body.command?.trim() ?? "";
  if (!input) return NextResponse.json({ error: "command is required" }, { status: 400 });
  if (input.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json(
      { error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` },
      { status: 400 },
    );
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const deployment = await appsApi.readNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
    });
    const gameType =
      deployment.metadata?.labels?.["infraweaver/game-type"] ??
      deployment.metadata?.labels?.["infraweaver.io/game-type"] ??
      "";

    const pods = await coreApi.listNamespacedPod({
      namespace: GAME_HUB_NAMESPACE,
      labelSelector: `app=${name}`,
    });
    const pod =
      pods.items.find((entry) => entry.status?.phase === "Running") ?? pods.items[0];
    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;
    const command = gameType.toLowerCase().includes("minecraft")
      ? `if [ -x /usr/local/bin/rcon-cli ]; then /usr/local/bin/rcon-cli ${shellQuote(input)}; elif command -v rcon-cli >/dev/null 2>&1; then rcon-cli ${shellQuote(input)}; else ${input}; fi`
      : `if command -v rcon-cli >/dev/null 2>&1; then rcon-cli ${shellQuote(input)}; else ${input}; fi`;

    const result = await execCommand(kc, GAME_HUB_NAMESPACE, podName, containerName, [
      "/bin/sh",
      "-c",
      command,
    ]);

    return NextResponse.json({
      output: result.stdout.trim() || result.stderr.trim(),
      ...(result.stderr.trim() ? { error: result.stderr.trim() } : {}),
    });
  } catch (error) {
    console.error("rcon route failed", error);
    return NextResponse.json({ error: safeError(error), output: "" }, { status: 500 });
  }
}
