import { withFleetRead } from "@/addons/wordpress-manager/api/fleet-guard";
import { getFleetSecurity } from "@/addons/wordpress-manager/lib/fleet/security-agg";

export const dynamic = "force-dynamic";

/** GET — live fleet security roll-up from real secure sources (RBAC: wordpress:read). */
export async function GET() {
  return withFleetRead("security", 30, getFleetSecurity);
}
