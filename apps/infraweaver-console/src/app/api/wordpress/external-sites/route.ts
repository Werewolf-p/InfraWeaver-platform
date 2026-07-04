// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { listExternalSitesHandler, createExternalSiteHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export function GET() {
  return listExternalSitesHandler();
}

export function POST(req: NextRequest) {
  return createExternalSiteHandler(req);
}
