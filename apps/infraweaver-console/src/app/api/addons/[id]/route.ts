import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ADDONS } from "@/lib/addons";
import { getEnabledAddons, setAddonEnabled } from "@/lib/addons-server";
import { safeError } from "@/lib/utils";
import { withRoute } from "@/lib/route-utils";

const patchBodySchema = z.object({
  enabled: z.boolean(),
});

export const GET = withRoute(null, async (_req: NextRequest, _session, _access, ctx) => {
  const { params } = ctx;
  const { id } = await params;

  try {
    const addon = (await getEnabledAddons()).find((entry) => entry.id === id);
    if (!addon) {
      return NextResponse.json({ error: "Addon not found" }, { status: 404 });
    }
    return NextResponse.json(addon);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const PATCH = withRoute("config:write", async (req: NextRequest, _session, _access, ctx) => {
  const { params } = ctx;
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
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
