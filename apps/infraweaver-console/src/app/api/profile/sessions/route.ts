import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findUserByEmail, authentikFetch, mapAuthentikSessions } from "@/lib/authentik";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user?.username) return NextResponse.json({ sessions: [] });

  const r = await authentikFetch(
    `/core/tokens/?user=${encodeURIComponent(user.username)}&page_size=20`
  );
  if (!r.ok) return NextResponse.json({ sessions: [] });
  const data = await r.json() as { results?: unknown[] };
  return NextResponse.json({ sessions: mapAuthentikSessions(data.results ?? []) });
}
