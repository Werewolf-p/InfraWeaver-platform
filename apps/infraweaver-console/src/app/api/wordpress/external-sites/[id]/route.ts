// Thin delegator — all logic lives in the wordpress-manager addon.
import { deleteExternalSiteHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return deleteExternalSiteHandler(id);
}
