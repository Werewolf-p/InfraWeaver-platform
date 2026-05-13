import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerDeployment, makeGameHubClients, parseDiscordWebhookConfig, sendDiscordWebhook } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

async function readConfig(name: string) {
  const clients = makeGameHubClients();
  const deployment = await getServerDeployment(clients.appsApi, name);
  return parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);
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
    return NextResponse.json({ config: await readConfig(name) });
  } catch (error) {
    console.error("webhook route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-webhook-post", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { action?: "save" | "test"; url?: string; events?: string[] };

  try {
    const clients = makeGameHubClients();
    if (body.action === "test") {
      const config = body.url ? { url: body.url, events: Array.isArray(body.events) ? body.events : [] } : await readConfig(name);
      if (!config?.url) {
        return NextResponse.json({ error: "No Discord webhook configured" }, { status: 400 });
      }
      await sendDiscordWebhook(config, "test", `InfraWeaver test notification for ${name}`);
      return NextResponse.json({ ok: true });
    }

    const payload = JSON.stringify({ url: body.url ?? "", events: Array.isArray(body.events) ? body.events : [] });
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: "game-hub",
      body: { metadata: { annotations: { "infraweaver/discord-webhook": payload } } },
      fieldManager: "infraweaver",
      force: true,
    });
    return NextResponse.json({ config: parseDiscordWebhookConfig(payload) });
  } catch (error) {
    console.error("save webhook failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-webhook-delete", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: "game-hub",
      body: { metadata: { annotations: { "infraweaver/discord-webhook": "" } } },
      fieldManager: "infraweaver",
      force: true,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("delete webhook failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
