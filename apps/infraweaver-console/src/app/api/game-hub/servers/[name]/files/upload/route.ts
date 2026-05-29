import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { validateContainerPath, validateContainerPathWithinRoot } from "@/lib/validate";
import { safeError } from "@/lib/utils";
import { resolveServerDataRoot } from "../data-root";

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

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-file-upload", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const rootPath = await resolveServerDataRoot(clients, name, pod);
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
    await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `mkdir -p ${shellQuote(directory)} && printf %s ${shellQuote(base64)} | base64 -d > ${shellQuote(targetPath)}`,
      30_000,
    );
    await auditLog("game-hub:file-upload", session.user?.email ?? "unknown", `uploaded ${targetPath}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "file:upload", details: targetPath });
    return NextResponse.json({ ok: true, path: targetPath });
  } catch (error) {
    console.error("file upload failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
