import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { Writable } from "stream";

const GAME_HUB_NS = "game-hub";
const MAX_COMMAND_LENGTH = 512;

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as { command: string };
  const command = body.command?.trim() ?? "";

  if (!command) {
    return NextResponse.json({ error: "No command provided" }, { status: 400 });
  }

  // Security: enforce max length
  if (command.length > MAX_COMMAND_LENGTH) {
    return NextResponse.json({ error: `Command too long (max ${MAX_COMMAND_LENGTH} chars)` }, { status: 400 });
  }

  // Audit log: record who ran what
  const userEmail = session.user?.email ?? "unknown";
  console.log(`[AUDIT] game-hub exec | user=${userEmail} | server=${name} | command=${command}`);

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await coreApi.listNamespacedPod({
      namespace: GAME_HUB_NS,
      labelSelector: `app=${name}`,
    });
    const pod = pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0];

    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    const exec = new k8s.Exec(kc);
    let stdout = "";
    let stderr = "";

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
        ["sh", "-c", command],
        stdoutStream, stderrStream, null, false,
        (status) => {
          clearTimeout(timeout);
          if (status?.status === "Failure") reject(new Error(status.message ?? "Command failed"));
          else resolve();
        },
      ).catch(reject);
    });

    return NextResponse.json({ stdout, stderr, success: true });
  } catch (err) {
    console.error(`[game-hub] exec failed | server=${name} | command=${command} |`, err);
    return NextResponse.json({ error: String(err), stdout: "", stderr: "", success: false }, { status: 500 });
  }
}
