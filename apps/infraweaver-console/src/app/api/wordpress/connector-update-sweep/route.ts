// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { connectorUpdateSweepHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

/** POST — fleet Connector reinstall; optional `{ sites?: string[] }` restricts it. */
export async function POST(req: NextRequest) {
  return connectorUpdateSweepHandler(req);
}
