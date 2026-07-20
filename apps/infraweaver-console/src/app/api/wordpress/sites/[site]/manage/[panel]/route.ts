// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { getManagePanelHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — one Manage panel's live data (capability gate enforced server-side; supports `?refresh=1`). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string; panel: string }> }) {
  const { site, panel } = await ctx.params;
  return getManagePanelHandler(req, site, panel);
}
