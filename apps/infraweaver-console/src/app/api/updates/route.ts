import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute("apps:read", async (req: NextRequest, session) => {
  if (!checkRateLimit(rateLimitKey("updates-list", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const res = await iwApiFetch("/updates", session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
});
