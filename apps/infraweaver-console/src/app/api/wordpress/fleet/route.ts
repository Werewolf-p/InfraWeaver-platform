// Thin delegator — all logic lives in the wordpress-manager addon.
import { getFleetHandler } from "@/addons/wordpress-manager/api/handlers";

export const dynamic = "force-dynamic";

/** GET — live fleet roll-up from real secure sources (RBAC: wordpress:read). */
export async function GET() {
  return getFleetHandler();
}
