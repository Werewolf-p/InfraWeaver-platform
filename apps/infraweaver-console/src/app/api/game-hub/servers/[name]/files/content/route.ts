import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { Writable } from "stream";

const GAME_HUB_NS = "game-hub";

async function execInPod(
  kc: import("@kubernetes/client-node").KubeConfig,
  k8s: typeof import("@kubernetes/client-node"),
  podName: string,
  containerName: string,
  command: string[],
  timeoutMs = 10000,
): Promise<{ stdout: string; stderr: string }> {
  const exec = new k8s.Exec(kc);
  let stdout = "";
  let stderr = "";
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve();
    };
    const timeout = setTimeout(() => done(), timeoutMs);
    const stdoutW = new Writable({ write(c, _, cb) { stdout += c.toString(); cb(); } });
    const stderrW = new Writable({ write(c, _, cb) { stderr += c.toString(); cb(); } });

    exec.exec(GAME_HUB_NS, podName, containerName, command, stdoutW, stderrW, null, false, (status) => {
      if (status?.status === "Failure") done(new Error(status.message ?? "Exec failed"));
      else done();
    }).then((ws) => {
      ws.on("close", () => done());
      ws.on("error", (err: Error) => done(err));
    }).catch((err: Error) => done(err));
  });

  return { stdout, stderr };
}

// GET /api/game-hub/servers/[name]/files/content?path=/data/server.properties
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
    const pod = pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    // Single exec: portable size check + base64 in one WebSocket
    const { stdout: raw, stderr } = await execInPod(kc, k8s, podName, containerName, [
      "sh", "-c",
      `SIZE=$(ls -la "${filePath}" 2>/dev/null | awk '{print $5}' | tail -1 || echo 0); ` +
      `if [ "$SIZE" -gt 5242880 ]; then echo "TOO_LARGE:$SIZE"; ` +
      `elif [ "$SIZE" -eq 0 ] && ! [ -f "${filePath}" ]; then echo "NOT_FOUND"; ` +
      `else base64 "${filePath}" 2>&1; fi`,
    ]);

    if (raw.startsWith("TOO_LARGE:")) {
      const size = parseInt(raw.split(":")[1] ?? "0", 10);
      return NextResponse.json({ error: "File too large (max 5MB)", size }, { status: 413 });
    }

    if (raw.trim() === "NOT_FOUND") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    if (!raw && stderr) return NextResponse.json({ error: stderr.trim() }, { status: 500 });

    const content = Buffer.from(raw.replace(/\s/g, ""), "base64").toString("utf8");
    return NextResponse.json({ path: filePath, content });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// PUT /api/game-hub/servers/[name]/files/content
// Body: { path: string, content: string }
export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const body = await req.json() as { path: string; content: string };
  const { path: filePath, content } = body;

  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
    const pod = pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    // Write file using base64 to handle special characters
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";

    const { stderr } = await execInPod(kc, k8s, podName, containerName, [
      "sh", "-c",
      `mkdir -p "${dir}" && echo "${b64}" | base64 -d > "${filePath}"`,
    ]);

    if (stderr) return NextResponse.json({ error: stderr.trim() }, { status: 500 });
    return NextResponse.json({ saved: true, path: filePath });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
