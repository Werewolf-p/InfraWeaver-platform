import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { username } = await params;
  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const r = await authentikFetch(`/core/tokens/?user=${encodeURIComponent(username)}&page_size=20`);
  if (!r.ok) return NextResponse.json({ sessions: [] });
  const data = await r.json();
  return NextResponse.json({ sessions: data.results ?? [] });
}
