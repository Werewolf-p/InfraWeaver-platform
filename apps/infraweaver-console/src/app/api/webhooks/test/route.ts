import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { url?: string; method?: string; headers?: Record<string, string>; body?: string };
  const { url, method = "GET", headers = {}, body: reqBody } = body;
  if (!url || !url.startsWith("http")) return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: reqBody && method !== "GET" ? reqBody : undefined,
    });
    const resBody = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    return NextResponse.json({ status: res.status, statusText: res.statusText, headers: resHeaders, body: resBody, latencyMs: Date.now() - start });
  } catch (err) {
    return NextResponse.json({ error: String(err), latencyMs: Date.now() - start }, { status: 500 });
  }
}
