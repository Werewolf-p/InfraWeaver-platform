// Thin delegator — all logic lives in the wordpress-manager addon.
import { getAccessHandler, syncAccessHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — list the users InfraWeaver authorizes for this site. */
export async function GET(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getAccessHandler(site);
}

/** POST — force a reconcile of the site's Authentik access group to match RBAC. */
export async function POST(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return syncAccessHandler(site);
}
