import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { validateContainerPath, validateContainerPathWithinRoot } from "@/lib/validate";
import { safeError } from "@/lib/utils";
import { resolveServerDataRoot } from "../data-root";

const fileSaveSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
}).strict();

async function requireRead(name: string) {
  const session = await auth();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, access };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const authz = await requireRead(name);
  if (authz.error) return authz.error;

  const filePath = req.nextUrl.searchParams.get("path");
  const download = req.nextUrl.searchParams.get("download") === "1";
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const rootPath = await resolveServerDataRoot(clients, name, pod);
    if (!validateContainerPath(filePath) || !validateContainerPathWithinRoot(filePath, rootPath)) {
      return NextResponse.json({ error: "Path must stay within the server data directory" }, { status: 400 });
    }

    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `SIZE=$(stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0); if [ \"$SIZE\" -gt 52428800 ]; then echo TOO_LARGE:$SIZE; else base64 ${shellQuote(filePath)} 2>&1; fi`);
    if (result.stdout.startsWith("TOO_LARGE:")) {
      return NextResponse.json({ error: "File too large (max 50MB)", size: Number.parseInt(result.stdout.split(":")[1] ?? "0", 10) }, { status: 413 });
    }
    if (!result.stdout && result.stderr) return NextResponse.json({ error: safeError(result.stderr.trim()) }, { status: 500 });

    const content = Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
    if (download) {
      const filename = filePath.split("/").pop() ?? `${name}-file`;
      return new Response(content, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename=${JSON.stringify(filename)}`,
        },
      });
    }

    return NextResponse.json({ path: filePath, content: content.toString("utf8") });
  } catch (error) {
    console.error("read file failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-files-put", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = fileSaveSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
  if (Buffer.byteLength(body.content ?? "", "utf8") > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "Content too large (max 10MB)" }, { status: 413 });
  }

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No pod found" }, { status: 404 });
    const rootPath = await resolveServerDataRoot(clients, name, pod);
    if (!validateContainerPath(body.path) || !validateContainerPathWithinRoot(body.path, rootPath)) {
      return NextResponse.json({ error: "Path must stay within the server data directory" }, { status: 400 });
    }

    const b64 = Buffer.from(body.content, "utf8").toString("base64");
    const dir = body.path.substring(0, body.path.lastIndexOf("/")) || "/";
    const result = await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(body.path)}`);
    if (result.stderr) return NextResponse.json({ error: safeError(result.stderr.trim()) }, { status: 500 });
    await auditLog("game-hub:file-save", session.user?.email ?? "unknown", `${name} ${body.path}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "file:save", details: body.path });
    return NextResponse.json({ saved: true, path: body.path });
  } catch (error) {
    console.error("save file failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export { PUT as POST };
