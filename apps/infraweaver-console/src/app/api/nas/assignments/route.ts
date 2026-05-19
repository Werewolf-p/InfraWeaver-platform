import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { loadUsersConfig } from "@/lib/users-config";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-assignments", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const { users: rawUsers } = await loadUsersConfig();
    const assignments = Object.entries(rawUsers).map(([username, data]) => ({
      username,
      name: (data.name as string) ?? username,
      nas_shares: (data.nas_shares as unknown[]) ?? [],
    }));
    return NextResponse.json({ assignments });
  } catch (e) {
    console.error("Failed to fetch assignments:", e);
    return NextResponse.json({ assignments: [] });
  }
}
