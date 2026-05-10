import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/admin";
import { authentikFetch } from "@/lib/authentik";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string; tokenId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { tokenId } = await params;
  await authentikFetch(`/core/tokens/${tokenId}/`, { method: "DELETE" });
  return NextResponse.json({ ok: true });
}
