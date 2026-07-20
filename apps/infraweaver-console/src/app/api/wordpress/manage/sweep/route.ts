// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import { manageSnapshotSweepHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

/** POST — hourly Manage-snapshot sweep (force-pull every site, warm the durable store). */
export async function POST(req: NextRequest) {
  return manageSnapshotSweepHandler(req);
}
