import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(rateLimitKey("updates-versions", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;

  const res = await iwApiFetch(`/updates/${encodeURIComponent(name)}/versions`, session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
