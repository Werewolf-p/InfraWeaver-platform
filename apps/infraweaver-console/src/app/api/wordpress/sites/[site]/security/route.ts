// Thin delegator — the fused Site Security surface's signed-channel API. GET =
// read verbs (scan/status/consent, wordpress:read); POST = write verbs (harden/
// consent, wordpress:write + same-origin). All logic lives in the addon.
import type { NextRequest } from "next/server";
import { securityReadHandler, securityWriteHandler } from "@/addons/wordpress-manager/api/security-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return securityReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return securityWriteHandler(req, site);
}
