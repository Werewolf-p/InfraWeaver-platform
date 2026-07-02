// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { deleteSiteHandler, setProtectionHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return deleteSiteHandler(site);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return setProtectionHandler(req, site);
}
