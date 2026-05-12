import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { loadKubeConfig } from "@/lib/k8s";
import { safeError } from "@/lib/utils";
import { Writable } from "stream";

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
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => done(), timeoutMs);
    const stdoutW = new Writable({ write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); } });
    const stderrW = new Writable({ write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); } });
    exec.exec(GAME_HUB_NAMESPACE, podName, containerName, command, stdoutW, stderrW, null, false, (status) => {
      if (status?.status === "Failure") done(new Error(status.message ?? "Exec failed"));
      else done();
    }).then((ws) => {
      ws.on("close", () => done());
      ws.on("error", (error: Error) => done(error));
    }).catch((error: Error) => done(error));
  });

  return { stdout, stderr };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const filePath = req.nextUrl.searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.find((entry) => entry.status?.phase === "Running") ?? pods.items?.[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });

    const result = await execInPod(kc, k8s, pod.metadata.name, pod.spec?.containers?.[0]?.name ?? name, [
      "sh",
      "-c",
      `SIZE=$(ls -la "${filePath}" 2>/dev/null | awk '{print $5}' | tail -1 || echo 0); if [ "$SIZE" -gt 5242880 ]; then echo "TOO_LARGE:$SIZE"; elif [ "$SIZE" -eq 0 ] && ! [ -f "${filePath}" ]; then echo "NOT_FOUND"; else base64 "${filePath}" 2>&1; fi`,
    ]);

    if (result.stdout.startsWith("TOO_LARGE:")) {
      return NextResponse.json({ error: "File too large (max 5MB)", size: parseInt(result.stdout.split(":")[1] ?? "0", 10) }, { status: 413 });
    }
    if (result.stdout.trim() == "NOT_FOUND") return NextResponse.json({ error: "File not found" }, { status: 404 });
    if (!result.stdout && result.stderr) return NextResponse.json({ error: result.stderr.trim() }, { status: 500 });
    return NextResponse.json({ path: filePath, content: Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8") });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { path: string; content: string };
  if (!body.path) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
    const pod = pods.items?.find((entry) => entry.status?.phase === "Running") ?? pods.items?.[0];
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });

    const b64 = Buffer.from(body.content, "utf8").toString("base64");
    const dir = body.path.substring(0, body.path.lastIndexOf("/")) || "/";
    const result = await execInPod(kc, k8s, pod.metadata.name, pod.spec?.containers?.[0]?.name ?? name, ["sh", "-c", `mkdir -p "${dir}" && echo "${b64}" | base64 -d > "${body.path}"`]);
    if (result.stderr) return NextResponse.json({ error: result.stderr.trim() }, { status: 500 });
    return NextResponse.json({ saved: true, path: body.path });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
