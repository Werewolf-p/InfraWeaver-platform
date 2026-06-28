// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { getPluginsHandler, setPluginsHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getPluginsHandler(site);
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return setPluginsHandler(req, site);
}
