import { NextRequest, NextResponse } from "next/server";
import { authentikFetch } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(
  ["users:read", "users:write", "users:invite", "rbac:admin"],
  async (_req: NextRequest, _session, _access, ctx) => {
    const { username } = (await ctx.params) as { username: string };
    const r = await authentikFetch(
      `/events/events/?user=${encodeURIComponent(username)}&action=login&page_size=50`
    );
    if (!r.ok) return NextResponse.json({ events: [] });
    const data = await r.json();
    return NextResponse.json({ events: data.results ?? [] });
  },
);
