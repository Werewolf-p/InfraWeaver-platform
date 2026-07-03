// Thin delegator — all logic lives in the wordpress-manager addon.
import { getHealthHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — read-only Site Health snapshot (WP/PHP versions, DB size, plugins, uploads). */
export async function GET(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getHealthHandler(site);
}
