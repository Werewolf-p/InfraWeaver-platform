// Thin delegator — the Site Health surface's signed-channel API. GET = read
// verbs (snapshot/redirects, wordpress:read); POST = write verbs (scan +
// redirect mutations, wordpress:write + same-origin). Maintenance mode goes
// through the orchestrator on the sibling `/maintenance` route, not here, so the
// two 503 layers stay mutually exclusive. All logic lives in the addon.
import type { NextRequest } from "next/server";
import { siteHealthReadHandler, siteHealthWriteHandler } from "@/addons/wordpress-manager/api/site-health-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return siteHealthReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return siteHealthWriteHandler(req, site);
}
