import { NextResponse } from "next/server";
import { z } from "zod";
import { GAME_HUB_NS, getServerDeployment, makeGameHubClients, parseDiscordWebhookConfig, sendDiscordWebhook, withGameHubAuth } from "@/lib/game-hub-server";
import { parseSafeExternalUrl } from "@/lib/outbound-url";
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

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
  try {
    return NextResponse.json({ config: await readConfig(name) });
  } catch (error) {
    console.error("webhook route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const POST = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-webhook-post", limit: 20, windowMs: 60_000 } },
  async ({ req, name }) => {
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
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "infraweaver/discord-webhook": payload } } },
        fieldManager: "infraweaver",

      });
      return NextResponse.json({ config: parseDiscordWebhookConfig(payload) });
    } catch (error) {
      console.error("save webhook failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);

export const DELETE = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-webhook-delete", limit: 10, windowMs: 60_000 } },
  async ({ name }) => {
    try {
      const clients = makeGameHubClients();
      await clients.appsApi.patchNamespacedDeployment({
        name,
        namespace: GAME_HUB_NS,
        body: { metadata: { annotations: { "infraweaver/discord-webhook": "" } } },
        fieldManager: "infraweaver",

      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      console.error("delete webhook failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
