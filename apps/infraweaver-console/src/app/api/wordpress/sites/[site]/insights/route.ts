// Thin delegator — the Insights surface's signed-channel API. GET = read verbs
// (summary/timeseries/activity, wordpress:read). No write verbs: every insight is
// read-only, so there is no POST/CSRF surface. All logic lives in the addon.
import type { NextRequest } from "next/server";
import { insightsReadHandler } from "@/addons/wordpress-manager/api/insights-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return insightsReadHandler(req, site);
}
