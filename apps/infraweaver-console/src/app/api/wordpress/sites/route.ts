// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { listSitesHandler, createSiteHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export function GET() {
  return listSitesHandler();
}

export function POST(req: NextRequest) {
  return createSiteHandler(req);
}
