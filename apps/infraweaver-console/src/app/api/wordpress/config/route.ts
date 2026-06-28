// Thin delegator — all logic lives in the wordpress-manager addon.
import { getConfigHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

export function GET() {
  return getConfigHandler();
}
