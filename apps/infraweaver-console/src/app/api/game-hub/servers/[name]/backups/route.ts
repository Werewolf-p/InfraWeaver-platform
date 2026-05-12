import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, execShell, getPrimaryContainerName, getServerDeployment, getServerPod, makeGameHubClients, readServerEgg, shellQuote } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

interface BackupEntry {
  filename: string;
  size: string;
  bytes: number;
  createdAt: string;
}

function parseBackups(output: string): BackupEntry[] {
  return output.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const parts = line.split("\t");
    if (parts.length < 4) return [];
    return [{
      filename: (parts[0] ?? "").replace("/tmp/", ""),
      size: parts[1] ?? "0",
      bytes: Number.parseInt(parts[2] ?? "0", 10),
      createdAt: parts[3] ?? new Date().toISOString(),
    }];
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function listBackups(name: string) {
  const clients = makeGameHubClients();
  const pod = await getServerPod(clients.coreApi, name, true);
  if (!pod?.metadata?.name) throw new Error("No running pod found");
  const result = await execShell(
    clients.kc,
    pod.metadata.name,
    getPrimaryContainerName(pod, name),
    "for file in /tmp/gameserver-backup-*.tar.gz; do [ -f \"$file\" ] || continue; stat -c '%n\t%s\t%s\t%y' \"$file\"; done",
    10_000,
  );
  return parseBackups(result.stdout);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("list backups failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-backup-post", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({ action: "create" })) as { action?: string };
  if ((body.action ?? "create") !== "create") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });

    const retention = Number.parseInt(deployment.metadata?.annotations?.["infraweaver/backup-retention"] ?? "7", 10) || 7;
    await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `filename=/tmp/gameserver-backup-$(date +%Y%m%d-%H%M%S).tar.gz && tar -czf \"$filename\" -C ${shellQuote(egg.mountPath)} . && ls -1t /tmp/gameserver-backup-*.tar.gz 2>/dev/null | tail -n +${retention + 1} | xargs -r rm -f`,
      30_000,
    );
    await auditLog("game-hub:backup", session.user?.email ?? "unknown", `created backup for ${name}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "backup:create", details: "Created manual backup" });
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("create backup failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-backup-delete", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:write", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { filename?: string };
  if (!body.filename) return NextResponse.json({ error: "filename is required" }, { status: 400 });

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `rm -f /tmp/${body.filename.replace(/[^a-zA-Z0-9._-]/g, "")}`);
    await appendServerAudit(clients.coreApi, name, { timestamp: new Date().toISOString(), user: session.user?.email ?? "unknown", action: "backup:delete", details: `Deleted ${body.filename}` });
    return NextResponse.json({ backups: await listBackups(name) });
  } catch (error) {
    console.error("delete backup failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
