import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { validateContainerPath } from "@/lib/validate";
import { safeError } from "@/lib/utils";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: string;
  permissions: string;
}

function parseLsTimestamp(value: string) {
  if (value.includes("T")) return value;
  const withYear = value.match(/\d{2}:\d{2}$/)
    ? `${value} ${new Date().getFullYear()}`
    : value;
  const parsed = new Date(withYear);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function parseLsOutput(output: string, basePath: string): FileEntry[] {
  const files: FileEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || line.startsWith("total ") || line.startsWith("ERROR:")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const perms = parts[0] ?? "----------";
    const sizeStr = parts[4] ?? "0";
    const date = parts.slice(5, 8).join(" ");
    const rawName = parts.slice(8).join(" ");
    if (rawName === "." || rawName === "..") continue;
    const namePart = rawName.split(" -> ")[0].trim();
    if (!namePart) continue;
    const cleanBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
    files.push({
      name: namePart,
      path: `${cleanBase}${namePart}`,
      type: perms[0] === "d" ? "directory" : perms[0] === "l" ? "symlink" : perms[0] === "-" ? "file" : "other",
      size: Number.parseInt(sizeStr, 10),
      modifiedAt: parseLsTimestamp(date),
      permissions: perms.replace(/^[dl-]/, ""),
    });
  }
  return files;
}

function parseStatOutput(output: string, basePath: string): FileEntry[] {
  const files: FileEntry[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || !line.includes("|")) continue;
    const [name, sizeStr, modifiedAt, perms, typeLabel] = line.split("|");
    if (!name || !sizeStr || !modifiedAt || !perms || !typeLabel) continue;
    const cleanBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
    const permissionBits = perms.slice(1) || perms;
    files.push({
      name,
      path: `${cleanBase}${name}`,
      type: typeLabel.includes("directory")
        ? "directory"
        : typeLabel.includes("symbolic link")
          ? "symlink"
          : typeLabel.includes("regular file")
            ? "file"
            : "other",
      size: Number.parseInt(sizeStr, 10),
      modifiedAt: new Date(Number.parseInt(modifiedAt, 10) * 1000).toISOString(),
      permissions: permissionBits,
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
  if (path !== "/" && !validateContainerPath(path)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const result = await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `cd ${shellQuote(path)} 2>/dev/null && for file in .[!.]* ..?* *; do [ -e "$file" ] || continue; stat -c '%n|%s|%Y|%A|%F' "$file" 2>/dev/null || ls -ld --color=never "$file"; done || echo ERROR:NO_SUCH_PATH`,
    );
    if (result.stdout.includes("ERROR:NO_SUCH_PATH") || result.stdout.includes("No such file") || result.stderr.includes("No such file")) {
      return NextResponse.json({ error: "Path not found", files: [] }, { status: 404 });
    }
    const files = result.stdout.includes("|")
      ? parseStatOutput(result.stdout, path)
      : parseLsOutput(result.stdout, path);
    return NextResponse.json({ path, files, readOnly: !hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name) });
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
  if (!validateContainerPath(body.path)) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

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
      if (!validateContainerPath(body.from) || !validateContainerPath(body.to)) {
        return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      }
      await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `mv ${shellQuote(body.from)} ${shellQuote(body.to)}`);
      await auditLog("game-hub:rename", authz.session?.user?.email ?? "unknown", `${name} ${body.from} -> ${body.to}`);
      await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: authz.session?.user?.email ?? "unknown", action: "file:rename", details: `${body.from} -> ${body.to}` });
      return NextResponse.json({ ok: true, from: body.from, to: body.to });
    }

    if (body.action === "extract") {
      if (!body.path) return NextResponse.json({ error: "path required" }, { status: 400 });
      if (!validateContainerPath(body.path)) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
      const destDir = body.path.replace(/\/[^/]+$/, "") || "/";
      const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
      const extractCmd = body.path.endsWith(".tar.gz") || body.path.endsWith(".tgz")
        ? `tar -xzf ${shellQuote(body.path)} -C ${shellQuote(destDir)}`
        : body.path.endsWith(".zip")
          ? `unzip -o ${shellQuote(body.path)} -d ${shellQuote(destDir)}`
          : null;
      if (!extractCmd) return NextResponse.json({ error: "Unsupported archive format" }, { status: 400 });
      const command = `SIZE=$(stat -c %s ${shellQuote(body.path)} 2>/dev/null || echo 0); if [ "$SIZE" -gt ${MAX_ARCHIVE_BYTES} ]; then echo ARCHIVE_TOO_LARGE; else ${extractCmd}; fi`;
      const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), command, 30_000);
      if (result.stdout.includes("ARCHIVE_TOO_LARGE")) {
        return NextResponse.json({ error: "Archive too large (max 512MB)" }, { status: 413 });
      }
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
  if (!validateContainerPath(path)) return NextResponse.json({ error: "Invalid path" }, { status: 400 });
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
