// Thin delegator — the fused Media Explorer's signed-channel API. GET = read
// verbs (list/tree/status, wordpress:read); POST = write verbs (optimize/offload/
// restore/folder, wordpress:write + same-origin). All logic lives in the addon.
import type { NextRequest } from "next/server";
import { mediaReadHandler, mediaWriteHandler } from "@/addons/wordpress-manager/api/media-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return mediaReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return mediaWriteHandler(req, site);
}
