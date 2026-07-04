// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import {
  enrollManagedSiteHandler,
  getManagedLinkHandler,
  unlinkManagedSiteHandler,
} from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return getManagedLinkHandler(site);
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return enrollManagedSiteHandler(site);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ site: string }> }) {
  const { site } = await ctx.params;
  return unlinkManagedSiteHandler(site);
}
