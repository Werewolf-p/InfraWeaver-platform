import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

async function listArtifacts(name: string) {
  const clients = makeGameHubClients();
  const pod = await getServerPod(clients.coreApi, name, true);
  if (!pod?.metadata?.name) throw new Error("No running pod found");
  const containerName = getPrimaryContainerName(pod, name);
  const [pluginsResult, modsResult] = await Promise.all([
    execShell(clients.kc, pod.metadata.name, containerName, "for file in /data/plugins/*.jar; do [ -f \"$file\" ] || continue; basename \"$file\"; done", 10_000),
    execShell(clients.kc, pod.metadata.name, containerName, "for file in /data/mods/*.jar; do [ -f \"$file\" ] || continue; basename \"$file\"; done", 10_000),
  ]);
  return {
    plugins: pluginsResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
    mods: modsResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean),
  };
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
    return NextResponse.json(await listArtifacts(name));
  } catch (error) {
    console.error("plugins route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-plugin-post", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { action?: "install"; type?: "plugin" | "mod"; url?: string; filename?: string };
  if (body.action !== "install" || !body.url || !body.filename) {
    return NextResponse.json({ error: "action, url, and filename are required" }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const dir = body.type === "plugin" ? "/data/plugins" : "/data/mods";
    await execShell(clients.kc, pod.metadata.name, getPrimaryContainerName(pod, name), `mkdir -p ${dir} && curl -L ${shellQuote(body.url)} -o ${shellQuote(`${dir}/${body.filename.replace(/[^a-zA-Z0-9._-]/g, "")}`)}`, 30_000);
    return NextResponse.json(await listArtifacts(name));
  } catch (error) {
    console.error("plugin install failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
