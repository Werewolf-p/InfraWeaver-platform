// Thin delegator — all logic lives in the wordpress-manager addon.
import { connectorUpdateSweepHandler } from "@/addons/wordpress-manager/api/iwsl-handlers";

export const dynamic = "force-dynamic";

export async function POST() {
  return connectorUpdateSweepHandler();
}
