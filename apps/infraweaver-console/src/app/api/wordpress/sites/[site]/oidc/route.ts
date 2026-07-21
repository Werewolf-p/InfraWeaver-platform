// Thin delegator — all logic lives in the wordpress-manager addon.
// GET  = read-only OIDC health check for the site.
// POST { reprovision: true } = check and self-heal (re-run idempotent SSO setup).
import type { NextRequest } from "next/server";
import { validateOidcHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return validateOidcHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return validateOidcHandler(req, site);
}
