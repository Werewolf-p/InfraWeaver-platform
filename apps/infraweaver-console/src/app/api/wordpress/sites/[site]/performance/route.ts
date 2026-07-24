// Thin delegator — the fused Performance surface's signed-channel API. GET = read
// verbs (status/audit, wordpress:read); POST = write verbs (purge/warm/configure/
// settings, wordpress:write + same-origin). All logic lives in the addon.
import type { NextRequest } from "next/server";
import { performanceReadHandler, performanceWriteHandler } from "@/addons/wordpress-manager/api/performance-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return performanceReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return performanceWriteHandler(req, site);
}
