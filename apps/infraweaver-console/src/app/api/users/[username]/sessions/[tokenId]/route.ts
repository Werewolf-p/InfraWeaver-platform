import { NextRequest, NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { authentikFetch, findUserByUsername, isValidAuthentikIdentifier, mapAuthentikSessions } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";
import { sessionActor } from "@/lib/user-guards";
import { z } from "zod";

const SessionDeleteParams = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  tokenId: z.string().trim().min(1).max(160),
});

export const DELETE = withRoute(
  ["users:invite", "users:write", "rbac:admin"],
  async (req: NextRequest, session, _access, ctx) => {
    const parsedParams = SessionDeleteParams.safeParse(await ctx.params);
    if (!parsedParams.success || !isValidAuthentikIdentifier(parsedParams.data.tokenId)) {
      return NextResponse.json({ error: "Invalid session identifier" }, { status: 400 });
    }

    const { username, tokenId } = parsedParams.data;
    const user = await findUserByUsername(username);
    if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

    const tokenResponse = await authentikFetch(`/core/tokens/?user=${encodeURIComponent(username)}&page_size=100`);
    if (!tokenResponse.ok) return NextResponse.json({ error: "Failed to load user sessions" }, { status: 502 });
    const tokenData = await tokenResponse.json() as { results?: unknown[] };
    const sessions = mapAuthentikSessions(tokenData.results ?? []);
    if (!sessions.some((entry) => entry.identifier === tokenId)) {
      return NextResponse.json({ error: "Session not found for user" }, { status: 404 });
    }

    const deleteResponse = await authentikFetch(`/core/tokens/${encodeURIComponent(tokenId)}/`, { method: "DELETE" });
    if (!deleteResponse.ok) return NextResponse.json({ error: "Failed to revoke session" }, { status: 502 });

    await auditLog("users:revoke-session", sessionActor(session), `Revoked Authentik session for ${username}`, {
      resource: `${username}/${tokenId}`,
      req,
    });

    return NextResponse.json({ ok: true });
  },
);
