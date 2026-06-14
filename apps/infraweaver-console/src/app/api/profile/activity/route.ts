import { NextResponse, NextRequest } from "next/server";
import { findUserByEmail, authentikFetch } from "@/lib/authentik";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute(null, async (_req: NextRequest, session) => {
  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json({ events: [] });

  const r = await authentikFetch(
    `/events/events/?user=${encodeURIComponent(user.username)}&action=login&page_size=20`
  );
  if (!r.ok) return NextResponse.json({ events: [] });
  const data = await r.json();
  return NextResponse.json({ events: data.results ?? [] });
});
