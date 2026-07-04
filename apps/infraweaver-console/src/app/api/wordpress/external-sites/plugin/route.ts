// Thin delegator — all logic lives in the wordpress-manager addon.
import { downloadConnectorPluginHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export function GET() {
  return downloadConnectorPluginHandler();
}
