// Thin delegator — all logic lives in the wordpress-manager addon.
import { downloadBundleHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

// POST, not GET: issuing a bundle mints a fresh single-use enroll_secret
// (invalidating any outstanding one). With SameSite=Lax session cookies a GET
// here would be reachable via cross-site top-level navigation (CSRF).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return downloadBundleHandler(id);
}
