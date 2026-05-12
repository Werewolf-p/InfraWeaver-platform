import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

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
      size: Number.parseInt(sizeStr, 10),
      modifiedAt: date,
      permissions: perms,
    });
  }
  return files;
}

async function writableAccess(req: NextRequest, name: string) {
  const session = await auth();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, access };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const path = req.nextUrl.searchParams.get("path") ?? "/";
  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `ls -la --time-style=+%Y-%m-%dT%H:%M:%S ${shellQuote(path)} 2>&1 || echo ERROR:$?`);
    if (result.stdout.includes("No such file") || result.stderr.includes("No such file")) {
      return NextResponse.json({ error: "Path not found", files: [] }, { status: 404 });
    }
    return NextResponse.json({ path, files: parseLsOutput(result.stdout, path), readOnly: !hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name) });
  } catch (error) {
    console.error("file listing failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-files-post", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { name } = await params;
  const authz = await writableAccess(req, name);
  if (authz.error) return authz.error;
  const body = await req.json() as { action?: "mkdir"; path?: string };
  if (body.action !== "mkdir" || !body.path) return NextResponse.json({ error: "mkdir path required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `mkdir -p ${shellQuote(body.path)}`);
    await auditLog("game-hub:mkdir", authz.session?.user?.email ?? "unknown", `${name} ${body.path}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: authz.session?.user?.email ?? "unknown", action: "file:mkdir", details: body.path });
    return NextResponse.json({ ok: true, path: body.path });
  } catch (error) {
    console.error("mkdir failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-files-patch", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { name } = await params;
  const authz = await writableAccess(req, name);
  if (authz.error) return authz.error;
  const body = await req.json() as { action?: "rename" | "extract"; from?: string; to?: string; path?: string };

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });

    if (body.action === "rename") {
      if (!body.from || !body.to) return NextResponse.json({ error: "rename from/to required" }, { status: 400 });
      await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `mv ${shellQuote(body.from)} ${shellQuote(body.to)}`);
      await auditLog("game-hub:rename", authz.session?.user?.email ?? "unknown", `${name} ${body.from} -> ${body.to}`);
      await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: authz.session?.user?.email ?? "unknown", action: "file:rename", details: `${body.from} -> ${body.to}` });
      return NextResponse.json({ ok: true, from: body.from, to: body.to });
    }

    if (body.action === "extract") {
      if (!body.path) return NextResponse.json({ error: "path required" }, { status: 400 });
      const command = body.path.endsWith(".tar.gz") || body.path.endsWith(".tgz")
        ? `tar -xzf ${shellQuote(body.path)} -C ${shellQuote(body.path.replace(/\/[^/]+$/, "") || "/")}`
        : body.path.endsWith(".zip")
          ? `unzip -o ${shellQuote(body.path)} -d ${shellQuote(body.path.replace(/\/[^/]+$/, "") || "/")}`
          : null;
      if (!command) return NextResponse.json({ error: "Unsupported archive format" }, { status: 400 });
      await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), command, 30_000);
      await auditLog("game-hub:extract", authz.session?.user?.email ?? "unknown", `${name} ${body.path}`);
      await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: authz.session?.user?.email ?? "unknown", action: "file:extract", details: body.path });
      return NextResponse.json({ ok: true, path: body.path });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    console.error("file patch failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-files-delete", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const { name } = await params;
  const authz = await writableAccess(req, name);
  if (authz.error) return authz.error;

  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (["/", "/data", "/config", "/etc", "/usr", "/bin", "/lib", "/proc", "/sys"].includes(path.replace(/\/$/, ""))) {
    return NextResponse.json({ error: "Cannot delete this path" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `rm -rf ${shellQuote(path)}`);
    if (result.stderr) return NextResponse.json({ error: result.stderr }, { status: 500 });
    await auditLog("game-hub:delete-file", authz.session?.user?.email ?? "unknown", `${name} ${path}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: authz.session?.user?.email ?? "unknown", action: "file:delete", details: path });
    return NextResponse.json({ deleted: true, path });
  } catch (error) {
    console.error("delete file failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
