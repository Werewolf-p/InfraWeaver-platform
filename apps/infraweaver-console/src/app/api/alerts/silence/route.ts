import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

interface Silence {
  id: string;
  name: string;
  matchers: string;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
}

const CreateSilenceSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  matchers: z.string().max(512).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  comment: z.string().max(512).optional(),
});

const silences: Silence[] = [];

export const GET = withAuth({ permission: "config:read" }, () => NextResponse.json({ silences }));

export const POST = withAuth({ permission: "config:write" }, async ({ req, session }) => {
  const parsed = CreateSilenceSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;
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
});

export const DELETE = withAuth({ permission: "config:write" }, ({ req }) => {
  const { searchParams } = req.nextUrl;
  const id = searchParams.get("id");
  const idx = silences.findIndex(s => s.id === id);
  if (idx === -1) return NextResponse.json({ error: "Not found" }, { status: 404 });
  silences.splice(idx, 1);
  return NextResponse.json({ ok: true });
});
