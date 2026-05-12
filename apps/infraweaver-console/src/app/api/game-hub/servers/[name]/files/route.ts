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

async function getPod(coreApi: import("@kubernetes/client-node").CoreV1Api, name: string) {
  const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NAMESPACE, labelSelector: `app=${name}` });
  return pods.items?.find((pod) => pod.status?.phase === "Running") ?? pods.items?.[0] ?? null;
}

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
}

function parseLsOutput(output: string, basePath: string): FileEntry[] {
  const files: FileEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith("total ") || line.startsWith("ERROR:")) continue;
    const match = line.match(/^([dlrwx\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const [, perms, sizeStr, date, rawName] = match;
    if (rawName === "." || rawName === "..") continue;
    const namePart = rawName.split(" -> ")[0].trim();
    if (!namePart) continue;
    const cleanBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
    files.push({
      name: namePart,
      path: `${cleanBase}${namePart}`,
      type: perms[0] === "d" ? "directory" : perms[0] === "l" ? "symlink" : perms[0] === "-" ? "file" : "other",
      size: parseInt(sizeStr, 10),
      modifiedAt: date,
      permissions: perms,
    });
  }
  return files;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "/";
  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pod = await getPod(coreApi, name);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const result = await execInPod(kc, k8s, pod.metadata.name, pod.spec?.containers?.[0]?.name ?? name, ["sh", "-c", `ls -la --time-style="+%Y-%m-%dT%H:%M:%S" "${path}" 2>&1 || echo "ERROR: $?"`]);
    if (result.stdout.includes("No such file") || result.stderr.includes("No such file")) {
      return NextResponse.json({ error: "Path not found", files: [] }, { status: 404 });
    }
    return NextResponse.json({ path, files: parseLsOutput(result.stdout, path) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (["/", "/data", "/config", "/etc", "/usr", "/bin", "/lib", "/proc", "/sys"].includes(path.replace(/\/$/, ""))) {
    return NextResponse.json({ error: "Cannot delete this path" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = loadKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pod = await getPod(coreApi, name);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const result = await execInPod(kc, k8s, pod.metadata.name, pod.spec?.containers?.[0]?.name ?? name, ["sh", "-c", `rm -rf "${path}"`]);
    if (result.stderr) return NextResponse.json({ error: result.stderr }, { status: 500 });
    return NextResponse.json({ deleted: true, path });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
