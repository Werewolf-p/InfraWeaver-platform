import { NextResponse } from "next/server";
import { getEnabledAddons } from "@/lib/addons-server";
import { safeError } from "@/lib/utils";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute("apps:read", async () => {
  try {
    return NextResponse.json(await getEnabledAddons());
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
