// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { grantAuthentikUserHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/**
 * POST — grant an existing Authentik user access to this site with a chosen
 * WordPress role, pre-creating their WordPress account by email.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return grantAuthentikUserHandler(req, site);
}
