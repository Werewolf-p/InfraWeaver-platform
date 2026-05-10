import { NextRequest, NextResponse } from "next/server";

// Reject private/loopback IP ranges to prevent SSRF
function isPrivateUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const hostname = parsed.hostname;
  // Loopback
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  // Private IPv4 ranges
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  ];
  for (const range of privateRanges) {
    if (range.test(hostname)) return true;
  }
  return false;
}

// Public endpoint — no session required. Used by the homepage widget to check
// reachability of configured services before the user authenticates.
export async function GET(req: NextRequest) {
  const urlParam = req.nextUrl.searchParams.get("urls") ?? "";
  const urls = urlParam.split(",").map(u => u.trim()).filter(Boolean);

  if (urls.length === 0) {
    return NextResponse.json({ results: {} });
  }

  // Validate all URLs before fetching (SSRF protection)
  for (const url of urls) {
    if (isPrivateUrl(url)) {
      return NextResponse.json({ error: `Blocked URL: ${url}` }, { status: 400 });
    }
  }

  const results = await Promise.allSettled(
    urls.map(async (url) => {
      const start = Date.now();
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        });
        const latencyMs = Date.now() - start;
        return { url, ok: res.ok, latencyMs };
      } catch {
        return { url, ok: false, latencyMs: Date.now() - start };
      }
    })
  );

  const output: Record<string, { ok: boolean; latencyMs: number }> = {};
  for (const result of results) {
    if (result.status === "fulfilled") {
      output[result.value.url] = { ok: result.value.ok, latencyMs: result.value.latencyMs };
    }
  }

  return NextResponse.json({ results: output });
}
