// Thin delegator — real fleet performance posture + optional Google PageSpeed.
import { withFleetRead } from "@/addons/wordpress-manager/api/fleet-guard";
import { getFleetPerformance } from "@/addons/wordpress-manager/lib/fleet/performance";
import { getFleetPageSpeed } from "@/addons/wordpress-manager/lib/fleet/pagespeed";

export const dynamic = "force-dynamic";

/**
 * GET — the live PHP/health posture (always real) plus the PageSpeed roll-up
 * (real when `PAGESPEED_API_KEY` is set, honestly degraded when not). RBAC +
 * rate-limit + error funnel are handled by `withFleetRead` (namespace-wide
 * `wordpress:read`, 30 req/min).
 */
export async function GET() {
  return withFleetRead("performance", 30, async () => ({
    perf: await getFleetPerformance(),
    pagespeed: await getFleetPageSpeed(),
  }));
}
