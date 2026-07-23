// Thin delegator — all logic lives in the wordpress-manager addon.
import type { NextRequest } from "next/server";
import {
  channelRegistryOpsHandler,
  getChannelRegistryHandler,
} from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

/** GET — the current release-channel → version board. */
export function GET() {
  return getChannelRegistryHandler();
}

/** POST — promote / rollback / set-version on the release board. */
export function POST(req: NextRequest) {
  return channelRegistryOpsHandler(req);
}
