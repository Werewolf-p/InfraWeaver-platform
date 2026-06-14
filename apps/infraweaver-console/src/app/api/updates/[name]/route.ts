import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withRoute } from "@/lib/route-utils";

const updateRequestSchema = z.object({
  version: z.string().min(1).max(100),
}).strict();

export const POST = withRoute("platform:update", async (req: NextRequest, session, _access, ctx) => {
  const { params } = ctx;
  if (!checkRateLimit(rateLimitKey("updates-apply", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const res = await iwApiFetch(`/updates/${encodeURIComponent(name)}`, session, getRequestClusterId(req), {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
});
