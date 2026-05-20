import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const clientErrorBodySchema = z.object({
  message: z.string().max(500),
  stack: z.string().max(5000).optional(),
  url: z.string().max(500).optional(),
  requestId: z.string().max(100).optional(),
}).strict();

export async function POST(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("client-errors", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const result = clientErrorBodySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "client_error",
      message: result.data.message,
      stack: result.data.stack ?? null,
      url: result.data.url ?? null,
      requestId: result.data.requestId ?? null,
    }) + "\n",
  );

  return NextResponse.json({ ok: true });
}
