// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { getManageOverviewHandler, runManageActionHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — Manage console overview: capabilities + summary. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getManageOverviewHandler(site);
}

/** POST — run one allow-listed Manage write action. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return runManageActionHandler(req, site);
}
