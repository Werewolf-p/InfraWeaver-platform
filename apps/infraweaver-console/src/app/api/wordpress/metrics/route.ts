// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { connectorMetricsHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  return connectorMetricsHandler(req);
}
