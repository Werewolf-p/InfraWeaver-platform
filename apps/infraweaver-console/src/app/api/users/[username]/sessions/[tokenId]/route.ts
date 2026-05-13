import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { authentikFetch } from "@/lib/authentik";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ username: string; tokenId: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { tokenId } = await params;
  await authentikFetch(`/core/tokens/${tokenId}/`, { method: "DELETE" });
  return NextResponse.json({ ok: true });
}
