import { NextResponse } from "next/server";
import { z } from "zod";
import { buildEggConfigMap, type GameEgg } from "@/lib/game-eggs";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import { writeServerManifest } from "@/lib/game-hub-manifest";
import { makeGameHubClients, readServerEgg, upsertConfigMap, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

const eggPatchBodySchema = z.object({
  egg: z.record(z.string(), z.unknown()),
});

export const GET = withGameHubAuth({ permission: "game-hub:read" }, async ({ name }) => {
  try {
    const clients = makeGameHubClients();
    const appsApi = clients.appsApi;
    const coreApi = clients.coreApi;
    let deployment = null;
    try {
      deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    } catch {}
    return NextResponse.json({ egg: await readServerEgg(coreApi, name, deployment ?? undefined) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const PATCH = withGameHubAuth({ permission: "game-hub:admin" }, async ({ req, name }) => {
  const rawBody = await req.json().catch(() => null);
  const parsed = eggPatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data as { egg: Partial<GameEgg> };

  try {
    const clients = makeGameHubClients();
    const appsApi = clients.appsApi;
    const coreApi = clients.coreApi;
    let deployment = null;
    try {
      deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NAMESPACE });
    } catch {}

    const existingEgg = await readServerEgg(coreApi, name, deployment ?? undefined);
    const mergedEgg: GameEgg = {
      ...existingEgg,
      ...body.egg,
      environment: body.egg.environment ?? existingEgg.environment,
      quickCommands: body.egg.quickCommands ?? existingEgg.quickCommands,
    };

    await upsertConfigMap(coreApi, buildEggConfigMap(GAME_HUB_NAMESPACE, name, mergedEgg), GAME_HUB_NAMESPACE);

    try {
      await writeServerManifest(name, clients);
    } catch (gitErr) {
      console.warn(`writeServerManifest failed after egg update for ${name}`, gitErr);
    }

    return NextResponse.json({ ok: true, egg: mergedEgg });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
