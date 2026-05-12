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
): Promise<{ stdout: string; stderr: string }> {
  const exec = new k8s.Exec(kc);
  let stdout = "";
  let stderr = "";

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(), 30000);
    const stdoutW = new Writable({ write(c, _, cb) { stdout += c.toString(); cb(); } });
    const stderrW = new Writable({ write(c, _, cb) { stderr += c.toString(); cb(); } });

    exec.exec(GAME_HUB_NS, podName, containerName, command, stdoutW, stderrW, null, false, (status) => {
      clearTimeout(timeout);
      if (status?.status === "Failure") reject(new Error(status.message ?? "Exec failed"));
      else resolve();
    }).catch(reject);
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

    // Check if it's binary (use file command if available, else check size)
    const { stdout: fileSize } = await execInPod(kc, k8s, podName, containerName, [
      "sh", "-c", `wc -c < "${filePath}" 2>/dev/null || echo "0"`,
    ]);
    const size = parseInt(fileSize.trim(), 10);

    if (size > 5 * 1024 * 1024) { // 5MB limit
      return NextResponse.json({ error: "File too large (max 5MB)", size }, { status: 413 });
    }

    // Read file content via base64 to handle special chars safely
    const { stdout: b64, stderr } = await execInPod(kc, k8s, podName, containerName, [
      "sh", "-c", `base64 "${filePath}" 2>&1`,
    ]);

    if (stderr && !b64) return NextResponse.json({ error: stderr.trim() }, { status: 500 });

    const content = Buffer.from(b64.replace(/\s/g, ""), "base64").toString("utf8");
    return NextResponse.json({ path: filePath, content, size });
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
