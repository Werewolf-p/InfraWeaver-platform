import { NextRequest, NextResponse } from "next/server";
import { handlers } from "@/lib/auth";
import { checkRateLimit, LOGIN_RATE_LIMIT, rateLimitKey } from "@/lib/rate-limit";

// Auth.js v5: the route handler handles all /api/auth/* endpoints.
// The middleware matcher excludes /api/auth/ so the auth(handler) wrapper
// does NOT intercept these routes — it threw UnknownAction for signin in v5 beta.

export const GET = handlers.GET;

export async function POST(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/auth/signin")) {
    if (!checkRateLimit(rateLimitKey("login", req), LOGIN_RATE_LIMIT.max, LOGIN_RATE_LIMIT.windowMs)) {
      return NextResponse.json({ error: "Too many login attempts" }, {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }
  return handlers.POST(req);
}
