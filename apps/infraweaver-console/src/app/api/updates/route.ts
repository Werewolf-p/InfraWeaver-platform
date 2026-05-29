import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("updates-list", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const res = await iwApiFetch("/updates", session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
