import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { appendServerAudit, makeGameHubClients, shellQuote, withGameHubAuth } from "@/lib/game-hub-server";
import { buildContainerRealpathGuard, PATH_ESCAPE_MARKER, validateContainerPath, validateContainerPathWithinRoot } from "@/lib/validate";
import { safeError } from "@/lib/utils";
import { withServerFileExec } from "../server-file-exec";

const fileSaveSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
}).strict();

// File contents can contain secrets (e.g. server.properties → rcon.password),
// so require the files tier for reads, not the broad game-hub:read.
export const GET = withGameHubAuth({ permission: "game-hub:files" }, async ({ req, name }) => {
  const filePath = req.nextUrl.searchParams.get("path");
  const download = req.nextUrl.searchParams.get("download") === "1";
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    return await withServerFileExec(clients, name, "read", async ({ exec, rootPath }) => {
      if (!validateContainerPath(filePath) || !validateContainerPathWithinRoot(filePath, rootPath)) {
        return NextResponse.json({ error: "Path must stay within the server data directory" }, { status: 400 });
      }

      // "existing-file" also rejects reading *through* a symlink final
      // component — `/data/link -> /etc/shadow` must not serve the target.
      const guard = buildContainerRealpathGuard(rootPath, [{ path: filePath, kind: "existing-file" }], shellQuote);
      // base64-streaming a file up to 50MB over k8s exec can exceed the 15s
      // default; the exec now rejects on timeout (a truncated read must not
      // surface as HTTP 200), so give it explicit headroom.
      const result = await exec(`${guard}\nSIZE=$(stat -c %s ${shellQuote(filePath)} 2>/dev/null || echo 0); if [ \"$SIZE\" -gt 52428800 ]; then echo TOO_LARGE:$SIZE; else base64 ${shellQuote(filePath)} 2>&1; fi`, 60_000);
      if (result.stdout.startsWith(PATH_ESCAPE_MARKER)) {
        return NextResponse.json({ error: "Path resolves outside the server data directory" }, { status: 400 });
      }
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
    });
  } catch (error) {
    console.error("read file failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const PUT = withGameHubAuth(
  { permission: "game-hub:files", rateLimit: { name: "game-hub-files-put", limit: 20, windowMs: 60_000 } },
  async ({ req, session, name }) => {
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
      return await withServerFileExec(clients, name, "write", async ({ exec, rootPath }) => {
        if (!validateContainerPath(body.path) || !validateContainerPathWithinRoot(body.path, rootPath)) {
          return NextResponse.json({ error: "Path must stay within the server data directory" }, { status: 400 });
        }

        const b64 = Buffer.from(body.content, "utf8").toString("base64");
        const dir = body.path.substring(0, body.path.lastIndexOf("/")) || "/";
        // "destination" resolves the deepest existing ancestor BEFORE mkdir -p
        // runs, so a symlinked prefix can't redirect the directory creation or
        // the write outside the root.
        const guard = buildContainerRealpathGuard(rootPath, [{ path: body.path, kind: "destination" }], shellQuote);
        const result = await exec(`${guard}\nmkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(body.path)}`);
        if (result.stdout.includes(PATH_ESCAPE_MARKER)) {
          return NextResponse.json({ error: "Path resolves outside the server data directory" }, { status: 400 });
        }
        if (result.stderr) return NextResponse.json({ error: safeError(result.stderr.trim()) }, { status: 500 });
        await auditLog("game-hub:file-save", session.user?.email ?? "unknown", `${name} ${body.path}`);
        await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "file:save", details: body.path });
        return NextResponse.json({ saved: true, path: body.path });
      });
    } catch (error) {
      console.error("save file failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);

export { PUT as POST };
