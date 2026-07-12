import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerToken, makeGameHubClients, readServerTokens, withGameHubAuth, writeServerTokens } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

const tokenCreateSchema = z.object({
  label: z.string().min(1),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const tokenDeleteSchema = z.object({
  tokenId: z.string().min(1),
});

export const GET = withGameHubAuth({ permission: "game-hub:admin" }, async ({ name }) => {
  try {
    const { coreApi } = makeGameHubClients();
    const tokens = await readServerTokens(coreApi, name);
    const now = Date.now();
    return NextResponse.json({
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `token` is destructured out to strip the secret from the API response
      tokens: tokens.map(({ token, expiresAt, ...entry }) => ({
        ...entry,
        expiresAt: expiresAt ?? null,
        isExpired: expiresAt ? new Date(expiresAt).getTime() < now : false,
      })),
    });
  } catch (error) {
    console.error("tokens route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const POST = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-token-post", limit: 10, windowMs: 60_000 } },
  async ({ req, name }) => {
    const rawBody = await req.json().catch(() => null);
    const parsedCreate = tokenCreateSchema.safeParse(rawBody);
    if (!parsedCreate.success) {
      return NextResponse.json({ error: "Validation failed", details: parsedCreate.error.flatten() }, { status: 400 });
    }

    try {
      const { coreApi } = makeGameHubClients();
      const tokens = await readServerTokens(coreApi, name);
      const baseRecord = createServerToken(parsedCreate.data.label.trim());
      const expiresAt = parsedCreate.data.expiresInDays
        ? new Date(Date.now() + parsedCreate.data.expiresInDays * 86_400_000).toISOString()
        : undefined;
      const record = expiresAt ? { ...baseRecord, expiresAt } : baseRecord;
      await writeServerTokens(coreApi, name, [...tokens, record]);
      return NextResponse.json({
        token: record.token,
        record: {
          id: record.id,
          label: record.label,
          prefix: record.prefix,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt ?? null,
        },
      }, { status: 201 });
    } catch (error) {
      console.error("create token failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);

export const DELETE = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-token-delete", limit: 10, windowMs: 60_000 } },
  async ({ req, name }) => {
    const rawDeleteBody = await req.json().catch(() => null);
    const parsedDelete = tokenDeleteSchema.safeParse(rawDeleteBody);
    if (!parsedDelete.success) {
      return NextResponse.json({ error: "Validation failed", details: parsedDelete.error.flatten() }, { status: 400 });
    }

    try {
      const { coreApi } = makeGameHubClients();
      const tokens = await readServerTokens(coreApi, name);
      await writeServerTokens(coreApi, name, tokens.filter((entry) => entry.id !== parsedDelete.data.tokenId));
      return NextResponse.json({ ok: true });
    } catch (error) {
      console.error("delete token failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
