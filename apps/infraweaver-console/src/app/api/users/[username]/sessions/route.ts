import { NextRequest, NextResponse } from "next/server";
import { authentikFetch, findUserByUsername, mapAuthentikSessions } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";
import { z } from "zod";

const SessionParams = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
});

export const GET = withRoute(
  ["users:read", "users:write", "users:invite", "rbac:admin"],
  async (_req: NextRequest, _session, _access, ctx) => {
    const parsedParams = SessionParams.safeParse(await ctx.params);
    if (!parsedParams.success) return NextResponse.json({ error: "Invalid username" }, { status: 400 });

    const user = await findUserByUsername(parsedParams.data.username);
    if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

    const r = await authentikFetch(`/core/tokens/?user=${encodeURIComponent(parsedParams.data.username)}&page_size=20`);
    if (!r.ok) return NextResponse.json({ sessions: [] });
    const data = await r.json() as { results?: unknown[] };
    return NextResponse.json({ sessions: mapAuthentikSessions(data.results ?? []) });
  },
);
