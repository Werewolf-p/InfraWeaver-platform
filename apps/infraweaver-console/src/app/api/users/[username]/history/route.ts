import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { authentikFetch } from "@/lib/authentik";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { username } = await params;
  const r = await authentikFetch(
    `/events/events/?user=${encodeURIComponent(username)}&action=login&page_size=50`
  );
  if (!r.ok) return NextResponse.json({ events: [] });
  const data = await r.json();
  return NextResponse.json({ events: data.results ?? [] });
}
