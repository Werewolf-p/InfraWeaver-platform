// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { listAuthentikUsersHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — search the Authentik directory for the "grant existing user" picker (`?q=`). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return listAuthentikUsersHandler(req, site);
}
