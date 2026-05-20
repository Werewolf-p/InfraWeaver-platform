import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const uploadPathSchema = z.object({
  path: z.string().optional(),
});

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
    const form = await req.formData();
    const file = form.get("file");
    const rawPath = String(form.get("path") ?? "/data");
    const pathParsed = uploadPathSchema.safeParse({ path: rawPath });
    const directory = pathParsed.success ? (pathParsed.data.path ?? "/data") : "/data";
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const targetPath = `${directory.replace(/\/$/, "")}/${file.name}`;
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
