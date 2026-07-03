// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { getMaintenanceHandler, setMaintenanceHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — current maintenance-mode state. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getMaintenanceHandler(site);
}

/** PUT — enable/disable the maintenance page. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return setMaintenanceHandler(req, site);
}
