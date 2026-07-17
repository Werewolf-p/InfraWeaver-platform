// Thin delegator — all logic lives in the wordpress-manager addon.
import { externalHealthCheckHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return externalHealthCheckHandler(id);
}
