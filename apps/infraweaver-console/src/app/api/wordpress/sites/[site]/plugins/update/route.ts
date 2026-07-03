// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { updatePluginsHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** POST — update every installed plugin to its latest version. */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return updatePluginsHandler(site);
}
