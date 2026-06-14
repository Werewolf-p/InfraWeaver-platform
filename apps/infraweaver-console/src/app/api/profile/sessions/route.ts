import { NextResponse, NextRequest } from "next/server";
import { findUserByEmail, authentikFetch, mapAuthentikSessions } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(null, async (_req: NextRequest, session) => {
  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user?.username) return NextResponse.json({ sessions: [] });

  const r = await authentikFetch(
    `/core/tokens/?user=${encodeURIComponent(user.username)}&page_size=20`
  );
  if (!r.ok) return NextResponse.json({ sessions: [] });
  const data = await r.json() as { results?: unknown[] };
  return NextResponse.json({ sessions: mapAuthentikSessions(data.results ?? []) });
});
