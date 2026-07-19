import { withFleetRead } from "@/addons/wordpress-manager/api/fleet-guard";
import { getFleetHistory } from "@/addons/wordpress-manager/lib/fleet/history";

export const dynamic = "force-dynamic";

/**
 * GET — fleet-wide Prometheus trend series (RBAC: wordpress:read, 60/min).
 * Degrades to `available:false` with a reason when PROMETHEUS_URL is unset.
 */
export async function GET() {
  return withFleetRead("history", 60, getFleetHistory);
}
