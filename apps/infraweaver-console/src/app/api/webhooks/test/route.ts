import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { parseSafeExternalUrl, requestSafeExternalUrl } from "@/lib/outbound-url";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_HEADERS = new Set(["connection", "content-length", "host", "transfer-encoding"]);

const webhookTestSchema = z.object({
  url: z.string().optional(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

function sanitizeHeaders(input: Record<string, string>) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey || BLOCKED_HEADERS.has(normalizedKey)) continue;
    if (/[^a-z0-9-]/i.test(normalizedKey)) continue;
    headers[normalizedKey] = String(value).slice(0, 4_096);
  }
  return headers;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("webhooks-test", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsedBody = webhookTestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const body = parsedBody.data;
  const method = (body.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) return NextResponse.json({ error: "Invalid method" }, { status: 400 });

  const url = body.url ? await parseSafeExternalUrl(body.url) : null;
  if (!url) return NextResponse.json({ error: "Invalid URL" }, { status: 400 });

  const headers = sanitizeHeaders(body.headers ?? {});
  const requestBody = typeof body.body === "string" ? body.body.slice(0, 100_000) : undefined;
  const start = Date.now();
  try {
    const res = await requestSafeExternalUrl(url, {
      method,
      headers,
      body: requestBody && method !== "GET" ? requestBody : undefined,
      maxResponseBytes: 100_000,
      timeoutMs: 8_000,
    });
    if (!res) {
      return NextResponse.json({ error: "Invalid URL", latencyMs: Date.now() - start }, { status: 400 });
    }
    return NextResponse.json({
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      body: res.body.toString("utf8"),
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err), latencyMs: Date.now() - start }, { status: 500 });
  }
}
