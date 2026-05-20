import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ADDONS } from "@/lib/addons";
import { getEnabledAddons, setAddonEnabled } from "@/lib/addons-server";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const patchBodySchema = z.object({
  enabled: z.boolean(),
});

function getErrorMessage(error: unknown) {
  return safeError(error);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const addon = (await getEnabledAddons()).find((entry) => entry.id === id);
    if (!addon) {
      return NextResponse.json({ error: "Addon not found" }, { status: 404 });
    }
    return NextResponse.json(addon);
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!ADDONS.some((addon) => addon.id === id)) {
    return NextResponse.json({ error: "Addon not found" }, { status: 404 });
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = patchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  try {
    return NextResponse.json(await setAddonEnabled(id, body.enabled));
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
