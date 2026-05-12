import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { createServerToken, makeGameHubClients, readServerTokens, writeServerTokens } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
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
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { label?: string };
  if (!body.label?.trim()) return NextResponse.json({ error: "label is required" }, { status: 400 });

  try {
    const { coreApi } = makeGameHubClients();
    const tokens = await readServerTokens(coreApi, name);
    const record = createServerToken(body.label.trim());
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
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { tokenId?: string };
  if (!body.tokenId) return NextResponse.json({ error: "tokenId is required" }, { status: 400 });

  try {
    const { coreApi } = makeGameHubClients();
    const tokens = await readServerTokens(coreApi, name);
    await writeServerTokens(coreApi, name, tokens.filter((entry) => entry.id !== body.tokenId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("delete token failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
