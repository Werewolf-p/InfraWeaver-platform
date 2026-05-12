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

    const stdoutW = new Writable({
      write(chunk, _enc, cb) { stdout += chunk.toString(); cb(); },
    });
    const stderrW = new Writable({
      write(chunk, _enc, cb) { stderr += chunk.toString(); cb(); },
    });

    exec.exec(
      GAME_HUB_NS, podName, containerName,
      command, stdoutW, stderrW, null, false,
      (status) => {
        if (status?.status === "Failure") done(new Error(status.message ?? "Exec failed"));
        else done();
      },
    ).then((ws) => {
      ws.on("close", () => done());
      ws.on("error", (err: Error) => done(err));
    }).catch((err: Error) => done(err));
  });

  return { stdout, stderr };
}

async function getPod(coreApi: import("@kubernetes/client-node").CoreV1Api, name: string) {
  const pods = await coreApi.listNamespacedPod({
    namespace: GAME_HUB_NS,
    labelSelector: `app=${name}`,
  });
  return pods.items?.find(p => p.status?.phase === "Running") ?? pods.items?.[0] ?? null;
}

// GET /api/game-hub/servers/[name]/files?path=/data
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const path = req.nextUrl.searchParams.get("path") ?? "/";

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pod = await getPod(coreApi, name);

    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No pod found" }, { status: 404 });
    }

    const podName = pod.metadata.name;
    const containerName = pod.spec?.containers?.[0]?.name ?? name;

    // List files using ls -la with null-terminated names
    const { stdout, stderr } = await execInPod(kc, k8s, podName, containerName, [
      "sh", "-c", `ls -la --time-style="+%Y-%m-%dT%H:%M:%S" "${path}" 2>&1 || echo "ERROR: $?"`,
    ]);

    if (stdout.includes("No such file") || stderr.includes("No such file")) {
      return NextResponse.json({ error: "Path not found", files: [] }, { status: 404 });
    }

    // Parse ls -la output
    const files = parseLsOutput(stdout, path);

    return NextResponse.json({ path, files });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// DELETE /api/game-hub/servers/[name]/files?path=/data/file.txt
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });

  // Safety: prevent deleting root or system dirs
  const dangerous = ["/", "/data", "/config", "/etc", "/usr", "/bin", "/lib", "/proc", "/sys"];
  if (dangerous.includes(path.replace(/\/$/, ""))) {
    return NextResponse.json({ error: "Cannot delete this path" }, { status: 403 });
  }

  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const pod = await getPod(coreApi, name);

    if (!pod?.metadata?.name) {
      return NextResponse.json({ error: "No pod found" }, { status: 404 });
    }

    const { stderr } = await execInPod(kc, k8s, pod.metadata.name, pod.spec?.containers?.[0]?.name ?? name, [
      "sh", "-c", `rm -rf "${path}"`,
    ]);

    if (stderr) return NextResponse.json({ error: stderr }, { status: 500 });
    return NextResponse.json({ deleted: true, path });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
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
  const lines = output.split("\n");

  for (const line of lines) {
    if (!line.trim() || line.startsWith("total ") || line.startsWith("ERROR:")) continue;

    // Parse: permissions links owner group size date name
    // Handle ACL marker (+) or SELinux (.) after the 10 permission chars
    const match = line.match(/^([dlrwx\-]{10}[+@.]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, perms, sizeStr, date, rawName] = match;
    // Skip . and ..
    if (rawName === "." || rawName === "..") continue;

    // Handle symlinks (name -> target)
    const namePart = rawName.split(" -> ")[0].trim();
    if (!namePart) continue;

    let fileType: FileEntry["type"] = "file";
    if (perms[0] === "d") fileType = "directory";
    else if (perms[0] === "l") fileType = "symlink";
    else if (perms[0] !== "-") fileType = "other";

    const cleanBase = basePath.endsWith("/") ? basePath : basePath + "/";
    files.push({
      name: namePart,
      path: cleanBase + namePart,
      type: fileType,
      size: parseInt(sizeStr, 10),
      modifiedAt: date,
      permissions: perms,
    });
  }

  return files;
}
