import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPelicanGameEgg } from "@/lib/pelican-eggs";
import { safeError } from "@/lib/utils";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { path } = await params;
  const requestedPath = path.join("/");

  try {
    const { egg, entry } = await getPelicanGameEgg(requestedPath);
    return NextResponse.json({ egg, path: entry.path, id: entry.id });
  } catch (error) {
    const message = safeError(error);
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
