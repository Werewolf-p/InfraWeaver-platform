// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { verifyExternalSiteHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return verifyExternalSiteHandler(req, id);
}
