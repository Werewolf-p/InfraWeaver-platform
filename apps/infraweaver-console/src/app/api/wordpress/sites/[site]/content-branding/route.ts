// Thin delegator — the Content / Branding / Config signed-channel API. GET = read
// verbs (branding/config, wordpress:read); POST = write verbs (branding-set /
// config-set / content-duplicate, per-verb RBAC + same-origin). All logic lives in
// the addon; every verb maps to a signed connector method (signed-channel invariant).
import type { NextRequest } from "next/server";
import {
  contentBrandingReadHandler,
  contentBrandingWriteHandler,
} from "@/addons/wordpress-manager/api/content-branding-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return contentBrandingReadHandler(req, site);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return contentBrandingWriteHandler(req, site);
}
