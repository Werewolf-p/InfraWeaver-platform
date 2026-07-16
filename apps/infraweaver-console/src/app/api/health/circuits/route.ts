import { NextResponse } from "next/server";
import { getAllCircuitBreakerStatuses } from "@/lib/circuit-breaker";
import { withAuth } from "@/lib/with-auth";

/** Current circuit-breaker states, for the degraded-backends banner. Auth-only. */
export const GET = withAuth({}, async () => {
  return NextResponse.json({ circuits: getAllCircuitBreakerStatuses() });
});
