import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { execShell, getPrimaryContainerName, getServerPod, makeGameHubClients, shellQuote } from "@/lib/game-hub-server";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const pluginInstallSchema = z.object({
  action: z.literal("install"),
  type: z.enum(["plugin", "mod"]).optional(),
  url: z.string().min(1),
  filename: z.string().min(1),
});

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
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
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
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:files", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsedBody = pluginInstallSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const body = parsedBody.data;

  const pluginUrl = await parseSafeExternalUrl(body.url);
  if (!pluginUrl) {
    return NextResponse.json({ error: "Invalid download URL" }, { status: 400 });
  }

  try {
    const download = await requestSafeExternalUrl(pluginUrl, {
      maxResponseBytes: 50 * 1024 * 1024,
      timeoutMs: 30_000,
    });
    if (!download || download.status < 200 || download.status >= 300) {
      return NextResponse.json({ error: "Failed to download plugin" }, { status: 502 });
    }

    const clients = makeGameHubClients();
    const pod = await getServerPod(clients.coreApi, name, true);
    if (!pod?.metadata?.name) return NextResponse.json({ error: "No running pod found" }, { status: 404 });
    const dir = body.type === "plugin" ? "/data/plugins" : "/data/mods";
    const targetPath = `${dir}/${body.filename.replace(/[^a-zA-Z0-9._-]/g, "")}`;
    const base64 = download.body.toString("base64");
    await execShell(
      clients.kc,
      pod.metadata.name,
      getPrimaryContainerName(pod, name),
      `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(base64)} | base64 -d > ${shellQuote(targetPath)}`,
      30_000,
    );
    return NextResponse.json(await listArtifacts(name));
  } catch (error) {
    console.error("plugin install failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
