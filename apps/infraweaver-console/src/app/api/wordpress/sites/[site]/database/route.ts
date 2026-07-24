// Thin delegator — the fused Database cockpit's signed-channel API. GET = read
// verb (analyze, wordpress:read); POST = write verbs (cleanup/schedule,
// wordpress:write + same-origin). All logic lives in the addon.
import type { NextRequest } from "next/server";
import { databaseReadHandler, databaseWriteHandler } from "@/addons/wordpress-manager/api/database-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return databaseReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return databaseWriteHandler(req, site);
}
