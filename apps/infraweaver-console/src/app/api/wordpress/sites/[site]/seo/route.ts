// Thin delegator — the SEO cockpit's signed-channel API. GET = read verb
// (status, wordpress:read); POST = write verbs (audit-run/alt-backfill/fix,
// wordpress:write + same-origin). All logic lives in the addon.
import type { NextRequest } from "next/server";
import { seoReadHandler, seoWriteHandler } from "@/addons/wordpress-manager/api/seo-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return seoReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return seoWriteHandler(req, site);
}
