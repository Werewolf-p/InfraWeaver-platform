import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { ADDONS } from "@/lib/addons";
import { setAddonEnabled } from "@/lib/addons-server";
import { getRole } from "@/lib/rbac";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Failed to update addon";
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!ADDONS.some((addon) => addon.id === id)) {
    return NextResponse.json({ error: "Addon not found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null) as { enabled?: boolean } | null;
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    return NextResponse.json(await setAddonEnabled(id, body.enabled));
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
