import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { createServerToken, makeGameHubClients, readServerTokens, writeServerTokens } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

const tokenCreateSchema = z.object({
  label: z.string().min(1),
});

const tokenDeleteSchema = z.object({
  tokenId: z.string().min(1),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { coreApi } = makeGameHubClients();
    const tokens = await readServerTokens(coreApi, name);
    return NextResponse.json({ tokens: tokens.map(({ token, ...entry }) => entry) });
  } catch (error) {
    console.error("tokens route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-token-post", req), 10, 60_000)) {
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

  const rawBody = await req.json().catch(() => null);
  const parsedCreate = tokenCreateSchema.safeParse(rawBody);
  if (!parsedCreate.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedCreate.error.flatten() }, { status: 400 });
  }

  try {
    const { coreApi } = makeGameHubClients();
    const tokens = await readServerTokens(coreApi, name);
    const record = createServerToken(parsedCreate.data.label.trim());
    await writeServerTokens(coreApi, name, [...tokens, record]);
    return NextResponse.json({ token: record.token, record: { id: record.id, label: record.label, prefix: record.prefix, createdAt: record.createdAt } }, { status: 201 });
  } catch (error) {
    console.error("create token failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-token-delete", req), 10, 60_000)) {
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
}
