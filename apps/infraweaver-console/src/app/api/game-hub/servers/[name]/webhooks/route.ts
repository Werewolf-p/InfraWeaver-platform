import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerDeployment, makeGameHubClients, parseDiscordWebhookConfig, sendDiscordWebhook } from "@/lib/game-hub-server";
import { parseSafeExternalUrl } from "@/lib/outbound-url";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const webhookPostSchema = z.object({
  action: z.enum(["save", "test"]).optional(),
  url: z.string().optional(),
  events: z.array(z.string()).optional(),
});

async function readConfig(name: string) {
  const clients = makeGameHubClients();
  const deployment = await getServerDeployment(clients.appsApi, name);
  return parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);
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
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsedBody = webhookPostSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const body = parsedBody.data;
  const validatedUrl = body.url ? await parseSafeExternalUrl(body.url) : null;
  if (body.url && !validatedUrl) {
    return NextResponse.json({ error: "Invalid webhook URL" }, { status: 400 });
  }

  try {
    const clients = makeGameHubClients();
    if (body.action === "test") {
      const config = validatedUrl
        ? { url: validatedUrl.toString(), events: Array.isArray(body.events) ? body.events : [] }
        : await readConfig(name);
      if (!config?.url) {
        return NextResponse.json({ error: "No Discord webhook configured" }, { status: 400 });
      }
      await sendDiscordWebhook(config, "test", `InfraWeaver test notification for ${name}`);
      return NextResponse.json({ ok: true });
    }

    const payload = JSON.stringify({ url: validatedUrl?.toString() ?? "", events: Array.isArray(body.events) ? body.events : [] });
    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: "game-hub",
      body: { metadata: { annotations: { "infraweaver/discord-webhook": payload } } },
      fieldManager: "infraweaver",

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
  const nameErr3 = validateK8sName(name);
  if (nameErr3) return NextResponse.json(nameErr3.error, { status: nameErr3.status });
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

    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("delete webhook failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
