// Thin delegator — the Email panel's signed-channel WRITE API. POST = write verbs
// (config/test/clear-log): wordpress:write (config ⇒ admin) + same-origin + audit.
// Reads are served by the merged panel probe. All logic lives in the addon.
import type { NextRequest } from "next/server";
import { emailWriteHandler } from "@/addons/wordpress-manager/api/email-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return emailWriteHandler(req, site);
}
