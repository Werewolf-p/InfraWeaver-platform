import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findUserByEmail, authentikFetch } from "@/lib/authentik";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const email = (session.user as { email?: string }).email ?? "";
  const user = await findUserByEmail(email);
  if (!user) return NextResponse.json({ events: [] });

  const r = await authentikFetch(
    `/events/events/?user=${encodeURIComponent(user.username)}&action=login&page_size=20`
  );
  if (!r.ok) return NextResponse.json({ events: [] });
  const data = await r.json();
  return NextResponse.json({ events: data.results ?? [] });
}
