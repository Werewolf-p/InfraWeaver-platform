import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { appendServerAudit, makeGameHubClients, shellQuote, withGameHubAuth } from "@/lib/game-hub-server";
import { buildContainerRealpathGuard, PATH_ESCAPE_MARKER, validateContainerPath, validateContainerPathWithinRoot } from "@/lib/validate";
import { safeError } from "@/lib/utils";
import { withServerFileExec } from "../server-file-exec";

const uploadPathSchema = z.object({
  path: z.string().optional(),
});

const BLOCKED_UPLOAD_EXTENSIONS = [
  ".exe",
  ".bat",
  ".cmd",
  ".sh",
  ".php",
  ".py",
  ".rb",
  ".pl",
  ".ps1",
  ".vbs",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
] as const;
const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024;

export const POST = withGameHubAuth(
  { permission: "game-hub:files", rateLimit: { name: "game-hub-file-upload", limit: 10, windowMs: 60_000 } },
  async ({ req, session, name }) => {
    try {
      const clients = makeGameHubClients();
      return await withServerFileExec(clients, name, "write", async ({ exec, rootPath }) => {
        const form = await req.formData();
        const file = form.get("file");
        const rawPath = String(form.get("path") ?? rootPath);
        const pathParsed = uploadPathSchema.safeParse({ path: rawPath });
        const directory = pathParsed.success ? (pathParsed.data.path ?? rootPath) : rootPath;
        if (!(file instanceof File)) {
          return NextResponse.json({ error: "file is required" }, { status: 400 });
        }
        if (!validateContainerPath(directory) || !validateContainerPathWithinRoot(directory, rootPath)) {
          return NextResponse.json({ error: "Upload path must stay within the server data directory" }, { status: 400 });
        }
        // Strip path separators from filename to prevent traversal via filename itself
        const safeFilename = file.name.split(/[/\\]/).filter(Boolean).pop() ?? "";
        if (!safeFilename || safeFilename === ".." || safeFilename === ".") {
          return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
        }
        const lowerFilename = safeFilename.toLowerCase();
        if (BLOCKED_UPLOAD_EXTENSIONS.some((extension) => lowerFilename.endsWith(extension))) {
          return NextResponse.json({ error: "File type not allowed for upload" }, { status: 400 });
        }
        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
          return NextResponse.json({ error: "File exceeds 500MB limit" }, { status: 400 });
        }

        const arrayBuffer = await file.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString("base64");
        const targetPath = `${directory.replace(/\/$/, "")}/${safeFilename}`;
        if (!validateContainerPathWithinRoot(targetPath, rootPath)) {
          return NextResponse.json({ error: "Upload path must stay within the server data directory" }, { status: 400 });
        }
        const guard = buildContainerRealpathGuard(rootPath, [{ path: targetPath, kind: "destination" }], shellQuote);
        const result = await exec(
          `${guard}\nmkdir -p ${shellQuote(directory)} && printf %s ${shellQuote(base64)} | base64 -d > ${shellQuote(targetPath)}`,
          30_000,
        );
        if (result.stdout.includes(PATH_ESCAPE_MARKER)) {
          return NextResponse.json({ error: "Upload path resolves outside the server data directory" }, { status: 400 });
        }
        await auditLog("game-hub:file-upload", session.user?.email ?? "unknown", `uploaded ${targetPath}`);
        await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "file:upload", details: targetPath });
        return NextResponse.json({ ok: true, path: targetPath });
      });
    } catch (error) {
      console.error("file upload failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
