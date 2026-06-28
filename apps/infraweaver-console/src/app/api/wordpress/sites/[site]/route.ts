// Thin delegator — all logic lives in the wordpress-manager addon.
import { deleteSiteHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return deleteSiteHandler(site);
}
