import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

interface Silence {
  id: string;
  name: string;
  matchers: string;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
}

const silences: Silence[] = [];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ silences });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as Partial<Silence>;
  const silence: Silence = {
    id: Date.now().toString(),
    name: body.name ?? "New Silence",
    matchers: body.matchers ?? "",
    startsAt: body.startsAt ?? new Date().toISOString(),
    endsAt: body.endsAt ?? new Date(Date.now() + 3600000).toISOString(),
    comment: body.comment ?? "",
    createdBy: (session.user as { name?: string }).name ?? "unknown",
  };
  silences.push(silence);
  return NextResponse.json({ silence });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const idx = silences.findIndex(s => s.id === id);
  if (idx === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  silences.splice(idx, 1);
  return NextResponse.json({ ok: true });
}
